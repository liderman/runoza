const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  safeStorage,
  Menu,
} = require("electron");
const path = require("node:path"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { createHost } = require("./host.cjs");
const { createExtensionSources } = require("./extension-sources.cjs");
app.setName("Runóza");
// Keep the established profile directory while changing the display name.
app.setPath("userData", path.join(app.getPath("appData"), "Runoza"));
// Separate local QA profiles keep device credentials and folder grants isolated.
if (process.env.RUNOZA_USER_DATA) {
  if (!path.isAbsolute(process.env.RUNOZA_USER_DATA))
    throw new Error("RUNOZA_USER_DATA must be an absolute path");
  app.setPath("userData", process.env.RUNOZA_USER_DATA);
}
app.enableSandbox();
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
let win,
  config = {},
  stopping = false,
  connectionCode = "",
  polling = false,
  connecting = false;
const active = new Set(),
  seen = new Set();
function validateServer(raw) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw Error("Enter the server address without a path.");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("Remote servers must use HTTPS.");
  return u.origin;
}
const store = () => path.join(app.getPath("userData"), "device.enc");
async function save() {
  if (!safeStorage.isEncryptionAvailable())
    throw Error("The system credential store is unavailable.");
  await fs.writeFile(
    store(),
    safeStorage.encryptString(JSON.stringify(config)),
    { mode: 0o600 },
  );
}
async function request(url, body, auth = true, credentials = config) {
  const response = await fetch(credentials.server + "/api/v1" + url, {
    method: "POST",
    headers: {
      origin: credentials.server,
      "content-type": "application/json",
      ...(auth ? { authorization: "Bearer " + credentials.token } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Error(value.code ?? value.error?.code ?? "SERVER_UNAVAILABLE");
  return value;
}
function trusted(e, connection = false) {
  const u = e.senderFrame?.url;
  if (
    e.sender !== win.webContents ||
    e.senderFrame !== win.webContents.mainFrame
  )
    throw Error("IPC_DENIED");
  if (connection) {
    if (
      u !==
      require("node:url").pathToFileURL(
        path.join(__dirname, "../dist/index.html"),
      ).href
    )
      throw Error("IPC_DENIED");
  } else if (!config.server || new URL(u).origin !== config.server)
    throw Error("IPC_DENIED");
}
const { createFolderTrust } = require("./folder-trust.cjs");
const folderTrust = createFolderTrust({
  read: () => ({
    identity: stopping ? null : config.token,
    folders: config.trustedFolders ?? [],
  }),
  remember: async (root) => {
    config.trustedFolders = [...(config.trustedFolders ?? []), root];
    await save();
  },
  confirm: async (root) => {
    const result = await dialog.showMessageBox(win, {
      type: "question",
      title: "Runóza workspace folder",
      message: "Allow Runóza to use this folder?",
      detail:
        "Server: " +
        config.server +
        "\nFolder: " +
        root +
        "\n\nThis permission applies to the selected folder. Commands run with your user account's privileges; the folder is not a sandbox. You can revoke access from the Runóza menu.",
      buttons: ["Cancel", "Allow for this folder"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  },
});
const trustFolder = (root) => folderTrust.approve(root);
const localSources = createExtensionSources(
  process.env.RUNOZA_CONFIG_DIR ?? app.getPath("userData"),
  () => config.folders ?? {},
);
const host = createHost({
  sources: localSources,
  pty: require("node-pty"),
  approve: trustFolder,
});
async function openWorkspace() {
  const r = await dialog.showOpenDialog(win, {
    title: "Runóza workspace folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled) return null;
  const folder = await fs.realpath(r.filePaths[0]);
  if (!(await trustFolder(folder))) return null;
  const id =
    Object.keys(config.folders ?? {}).find(
      (id) => config.folders[id] === folder,
    ) ?? crypto.randomUUID();
  const result = await request("/desktop/workspaces", {
    id,
    name: path.basename(folder),
  });
  config.folders = { ...config.folders, [id]: folder };
  await save();
  return { ...result, path: folder };
}
async function authenticatedWindow(cookie) {
  await session.defaultSession.cookies.set({
    url: config.server,
    name: cookie.cookieName,
    value: cookie.cookie,
    httpOnly: true,
    secure: config.server.startsWith("https:"),
    sameSite: "lax",
    path: "/",
  });
  await win.loadURL(config.server);
  void poll();
}
async function connect(raw) {
  config = { server: validateServer(raw), folders: {} };
  const link = await request("/desktop/link", { name: os.hostname() }, false);
  connectionCode = link.code;
  if (new URL(link.url).origin !== config.server)
    throw Error("LINK_ORIGIN_INVALID");
  await shell.openExternal(link.url);
  for (let i = 0; i < 290 && !stopping; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await request(
      "/desktop/exchange",
      { id: link.id, secret: link.secret },
      false,
    );
    if (result.pending) continue;
    config = { ...config, token: result.token, deviceId: result.deviceId };
    connectionCode = "";
    await save();
    await authenticatedWindow(result);
    return { ok: true };
  }
  throw Error("LINK_EXPIRED");
}
async function poll() {
  if (polling) return;
  polling = true;
  const credentials = { ...config };
  try {
    while (!stopping && config.token === credentials.token) {
      try {
        const result = await request("/desktop/poll", {}, true, credentials);
        for (const c of result.cancelled) host.cancel(c.id);
        for (const job of result.jobs) {
          if (seen.has(job.id) || active.has(job.id)) {
            await request(
              "/desktop/jobs/" + job.id + "/result",
              { error: "EXECUTION_UNKNOWN" },
              true,
              credentials,
            );
            continue;
          }
          seen.add(job.id);
          active.add(job.id);
          void (async () => {
            let result, error;
            try {
              const root =
                config.token === credentials.token
                  ? config.folders?.[job.workspace_id]
                  : undefined;
              if (!root) throw Error("LOCAL_FOLDER_UNAVAILABLE");
              result = await host.action(
                root,
                job.operation,
                job.payload,
                job.id,
              );
            } catch (e) {
              error = /^[A-Z_]+$/.test(e.message)
                ? e.message
                : "LOCAL_EXECUTION_FAILED";
            }
            try {
              await request(
                "/desktop/jobs/" + job.id + "/result",
                { result, error },
                true,
                credentials,
              );
            } catch {
            } finally {
              active.delete(job.id);
            }
          })();
        }
      } catch (e) {
        if (
          e.message === "DEVICE_REVOKED" &&
          config.token === credentials.token
        ) {
          host.stop();
          config.token = null;
          await save();
          await win.loadFile(path.join(__dirname, "../dist/index.html"));
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    polling = false;
    if (!stopping && config.token && config.token !== credentials.token)
      void poll();
  }
}
app.whenReady().then(async () => {
  try {
    if (safeStorage.isEncryptionAvailable())
      config = JSON.parse(
        safeStorage.decryptString(await fs.readFile(store())),
      );
  } catch {}
  const icon = path.join(__dirname, "../assets/icon.png");
  if (process.platform === "darwin") app.dock.setIcon(icon);
  win = new BrowserWindow({
    icon,
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 600,
    title: "Runóza",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (config.server && new URL(url).origin !== config.server) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  session.defaultSession.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  ipcMain.handle("desktop:status", (e) => {
    if (
      e.sender !== win.webContents ||
      e.senderFrame !== win.webContents.mainFrame
    )
      throw Error("IPC_DENIED");
    return {
      deviceId: config.deviceId,
      server:
        config.server ?? process.env.RUNOZA_SERVER ?? "http://127.0.0.1:53009",
      code: connectionCode,
      platform: process.platform,
    };
  });
  ipcMain.handle("desktop:connect", (e, url) => {
    trusted(e, true);
    if (connecting) throw Error("LINK_PENDING");
    connecting = true;
    return connect(url).finally(() => {
      connectionCode = "";
      connecting = false;
    });
  });
  ipcMain.handle("desktop:extensions:list", (e) => {
    trusted(e);
    return localSources.scan();
  });
  ipcMain.handle("desktop:extensions:read", (e, id) => {
    trusted(e);
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw Error("SOURCE_INVALID");
    return localSources.read(id);
  });
  ipcMain.handle("desktop:folder", (e) => {
    trusted(e);
    return openWorkspace();
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Runóza",
        submenu: [
          { role: "about" },
          {
            label: "Change Server or Connect",
            click: async () => {
              host.stop();
              config.token = null;
              await save();
              await win.loadFile(path.join(__dirname, "../dist/index.html"));
            },
          },
          {
            label: "Revoke Workspace Folder Access",
            click: async () => {
              host.stop();
              folderTrust.invalidate();
              config.trustedFolders = [];
              await save();
            },
          },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
    ]),
  );
  if (config.token) {
    try {
      await authenticatedWindow(await request("/desktop/session"));
    } catch {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
    }
  } else await win.loadFile(path.join(__dirname, "../dist/index.html"));
});
app.on("second-instance", () => {
  win?.show();
  win?.focus();
});
app.on("before-quit", () => {
  stopping = true;
  host.stop();
});
app.on("window-all-closed", () => app.quit());
