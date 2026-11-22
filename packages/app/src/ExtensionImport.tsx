import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Dialog,
  Flex,
  Label,
  Select,
  Text,
  useFileInput,
} from "@gravity-ui/uikit";
import {
  unpackSkillZip,
  skillPath,
  packageLimits,
  type FileView,
  type ProjectView,
} from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import type { ExtensionEntry } from "./SkillCommands.tsx";
type LocalCatalog = Awaited<
  ReturnType<NonNullable<Window["runozaDesktop"]>["localExtensions"]>
>;
type FileData = { path: string; bytes: Uint8Array<ArrayBuffer> };
export function ExtensionImport({
  api,
  locale,
  local = false,
}: {
  api: IdentityClient;
  locale: "en" | "ru";
  local?: boolean;
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b),
    client = useQueryClient();
  const [files, setFiles] = useState<FileData[] | null>(null),
    [source, setSource] = useState("upload"),
    [projectId, setProjectId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [mcp, setMcp] = useState<LocalCatalog["mcp"][number] | null>(null);
  const native = window.runozaDesktop;
  const sources = useQuery({
    queryKey: ["extensions", "local-sources"],
    queryFn: () => native!.localExtensions(),
    enabled: local && Boolean(native?.localExtensions),
    refetchInterval: local ? 10000 : false,
    refetchOnWindowFocus: true,
  });
  const projects = useQuery({
    queryKey: ["extensions", "import-projects"],
    queryFn: () => api.request<{ projects: ProjectView[] }>("/projects"),
    enabled: Boolean(files || mcp),
  });
  async function prepare(input: File[]) {
    setError("");
    try {
      if (
        input.length > packageLimits.files ||
        input.reduce((n, f) => n + f.size, 0) > packageLimits.totalBytes ||
        input.some(
          (f) =>
            f.size >
            (input.length === 1 && f.name.toLowerCase().endsWith(".zip")
              ? packageLimits.totalBytes
              : packageLimits.fileBytes),
        )
      )
        throw Error("limit");
      let result: FileData[];
      if (input.length === 1 && input[0]!.name.toLowerCase().endsWith(".zip"))
        result = unpackSkillZip(
          new Uint8Array(await input[0]!.arrayBuffer()),
        ).map((f) => ({ path: f.path, bytes: Uint8Array.from(f.bytes) }));
      else {
        const names = input.map((f) => f.webkitRelativePath || f.name);
        const prefix = names.every(
          (n) => n.includes("/") && n.split("/")[0] === names[0]!.split("/")[0],
        )
          ? names[0]!.split("/")[0] + "/"
          : "";
        result = await Promise.all(
          input.map(async (f, i) => ({
            path: names[i]!.slice(prefix.length),
            bytes: new Uint8Array(await f.arrayBuffer()),
          })),
        );
      }
      if (
        result.length > packageLimits.files ||
        result.reduce((n, f) => n + f.bytes.length, 0) >
          packageLimits.totalBytes ||
        result.some(
          (f) => !skillPath(f.path) || f.bytes.length > packageLimits.fileBytes,
        ) ||
        new Set(result.map((f) => f.path.toLowerCase())).size !==
          result.length ||
        !result.some((f) => f.path === "SKILL.md")
      )
        throw Error("invalid");
      setSource("upload");
      setProjectId("");
      setFiles(result);
    } catch {
      setError(
        s(
          "Не удалось прочитать пакет. Нужен SKILL.md в корне; до 128 файлов и 20 МиБ без небезопасных путей.",
          "Could not read package. Root SKILL.md required; up to 128 files / 20 MiB with safe paths.",
        ),
      );
    }
  }
  const zip = useFileInput({ onUpdate: (files) => void prepare(files) }),
    folder = useFileInput({ onUpdate: (files) => void prepare(files) });
  async function importFiles() {
    if (!files) return;
    setBusy(true);
    setError("");
    const uploaded: string[] = [];
    try {
      const catalog = await api.request<{ extensions: ExtensionEntry[] }>(
        "/extensions/catalog" + (projectId ? "?projectId=" + projectId : ""),
      );
      const previous = catalog.extensions.find(
        (x) =>
          x.kind === "skill" &&
          x.owned &&
          x.manifest?.source === source &&
          source !== "upload",
      );
      const entries = [];
      for (const file of files) {
        const created = await api.request<FileView>("/files", "POST", {
          name: file.path.split("/").at(-1),
          size: file.bytes.length,
          mediaType: "application/octet-stream",
          ...(projectId ? { projectId } : {}),
        });
        uploaded.push(created.id);
        await api.upload(
          created.id,
          new Blob([file.bytes]),
          new AbortController().signal,
        );
        entries.push({ path: file.path, fileId: created.id });
      }
      const imported = await api.request<{ id: string }>(
        "/skills/import",
        "POST",
        {
          files: entries,
          visibility: projectId ? "project" : "personal",
          ...(projectId ? { projectId } : {}),
          ...(previous ? { skillId: previous.id } : {}),
          source,
        },
      );
      await api.request("/extensions/bindings", "PUT", {
        kind: "skill",
        resourceId: imported.id,
        scope: projectId ? "project" : "user",
        ...(projectId ? { scopeId: projectId } : {}),
        enabled: true,
        pinned: false,
      });
      setFiles(null);
      await client.invalidateQueries({ queryKey: ["extensions"] });
    } catch {
      setError(
        s(
          "Импорт не завершён. Проверьте SKILL.md, права и доступность хранилища.",
          "Import incomplete. Check SKILL.md, permissions and storage.",
        ),
      );
      for (const id of uploaded)
        await api.request("/files/" + id, "DELETE").catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function readLocal(id: string) {
    setError("");
    try {
      const read = await native!.readLocalSkill(id);
      setFiles(
        read.map((f) => ({
          path: f.path,
          bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)),
        })),
      );
      setSource("local:" + id);
      setProjectId("");
    } catch {
      setError(
        s(
          "Не удалось прочитать источник. Обновите список.",
          "Could not read source. Refresh the list.",
        ),
      );
    }
  }
  async function importMcp() {
    if (!mcp) return;
    setBusy(true);
    setError("");
    try {
      const device = await native!.status();
      if (mcp.transport === "stdio" && !device.deviceId) throw Error("device");
      await api.request("/mcp/install", "POST", {
        name: mcp.name,
        transport: mcp.transport,
        ...(mcp.transport === "stdio"
          ? { command: mcp.command, deviceId: device.deviceId }
          : { endpoint: mcp.endpoint }),
        allowedTools: mcp.allowedTools,
        enabled: mcp.enabled,
        cwd: mcp.cwd,
        envRefs: mcp.envRefs,
        visibility: projectId ? "project" : "personal",
        ...(projectId ? { projectId } : {}),
        source: mcp.id,
      });
      setMcp(null);
      await client.invalidateQueries({ queryKey: ["extensions"] });
    } catch {
      setError(
        s(
          "Не удалось подключить MCP. Проверьте конфиг и вход на устройство.",
          "Could not connect MCP. Check configuration and device sign-in.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const scope = (
    <Select
      aria-label={s("Область установки", "Installation scope")}
      value={[projectId]}
      onUpdate={(v) => setProjectId(v[0] ?? "")}
      disabled={busy}
      options={[
        { value: "", content: s("Лично для меня", "Personal") },
        ...(projects.data?.projects ?? [])
          .filter((p) => p.role !== "viewer")
          .map((p) => ({ value: p.id, content: p.name })),
      ]}
    />
  );
  return (
    <Flex direction="column" gap="spacing-3">
      {error && (
        <Alert theme="danger" message={error} onClose={() => setError("")} />
      )}
      {!local ? (
        <Flex gap="spacing-2" wrap="wrap">
          <input {...zip.controlProps} accept=".zip" />
          <Button {...zip.triggerProps}>{s("Импорт ZIP", "Import ZIP")}</Button>
          <input
            {...folder.controlProps}
            multiple
            ref={(node) => {
              const original = folder.controlProps.ref;
              if (typeof original === "function") original(node);
              else if (original) original.current = node;
              if (node) node.setAttribute("webkitdirectory", "");
            }}
          />
          <Button {...folder.triggerProps}>
            {s("Импорт папки", "Import folder")}
          </Button>
        </Flex>
      ) : !native?.localExtensions ? (
        <Text color="secondary">
          {s(
            "Для чтения локальных источников откройте обновлённый десктопный клиент. В web используйте импорт папки или ZIP.",
            "Open the updated desktop client to read local sources. On the web, import a folder or ZIP.",
          )}
        </Text>
      ) : (
        <>
          <Flex justifyContent="space-between" gap="spacing-2">
            <Text color="secondary">
              {s(
                "Только каталог пользователя и выбранные рабочие папки. Чтение не запускает скрипты или MCP.",
                "Only your configuration directory and selected workspace folders. Reading never starts scripts or MCP.",
              )}
            </Text>
            <Button
              loading={sources.isFetching}
              onClick={() => void sources.refetch()}
            >
              {s("Обновить", "Refresh")}
            </Button>
          </Flex>
          {sources.isError && (
            <Alert
              theme="danger"
              message={s("Источники недоступны.", "Sources unavailable.")}
            />
          )}
          {sources.data?.skills.map((skill) => (
            <Flex
              key={skill.id}
              alignItems="center"
              justifyContent="space-between"
              gap="spacing-3"
            >
              <Flex direction="column" gap="spacing-1">
                <Text>{skill.name}</Text>
                <Text variant="caption-2" color="secondary">
                  {skill.path} · {skill.fileCount} {s("файлов", "files")}
                </Text>
              </Flex>
              <Button onClick={() => void readLocal(skill.id)}>
                {s("Импорт / обновить", "Import / update")}
              </Button>
            </Flex>
          ))}
          {sources.data?.mcp.map((entry) => (
            <Flex
              key={entry.id}
              alignItems="center"
              justifyContent="space-between"
              gap="spacing-3"
            >
              <Flex direction="column" gap="spacing-1">
                <Text>{entry.name} · MCP</Text>
                <Text variant="caption-2" color="secondary">
                  {entry.source} · {entry.transport}
                </Text>
              </Flex>
              <Button
                onClick={() => {
                  setMcp(entry);
                  setProjectId("");
                }}
              >
                {s("Подключить", "Connect")}
              </Button>
            </Flex>
          ))}
          {sources.data?.errors.map((e) => (
            <Alert
              key={e.source}
              theme="warning"
              message={e.source + ": " + e.code}
            />
          ))}
          {sources.data &&
            !sources.data.skills.length &&
            !sources.data.mcp.length && (
              <Text color="secondary">
                {s(
                  "Источники пока пусты. Добавьте SKILL.md или mcp_servers в config.toml.",
                  "No sources yet. Add SKILL.md packages or mcp_servers to config.toml.",
                )}
              </Text>
            )}
        </>
      )}
      <Dialog
        open={Boolean(files)}
        onOpenChange={(open) => {
          if (!open && !busy) setFiles(null);
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header
          caption={s("Импорт пакета skill", "Import skill package")}
        />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            <Text color="secondary">
              {s(
                "Инструкции и ресурсы сохранятся на вашем сервере. Скрипты будут доступны как файлы; для исполнения потребуется разрешение в рабочей области.",
                "Instructions and resources are stored on your server. Scripts remain files; executing them requires workspace approval.",
              )}
            </Text>
            {scope}
            <Text variant="caption-2">
              {files?.length} {s("файлов", "files")} ·{" "}
              {Math.ceil(
                (files?.reduce((n, f) => n + f.bytes.length, 0) ?? 0) / 1024,
              )}{" "}
              KiB
            </Text>
            <pre className="skill-preview">
              {files?.map((f) => f.path).join("\n")}
            </pre>
            {error && <Alert theme="danger" message={error} />}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          onClickButtonCancel={() => {
            if (!busy) setFiles(null);
          }}
          textButtonApply={s("Импортировать и включить", "Import and enable")}
          onClickButtonApply={() => void importFiles()}
          propsButtonApply={{ loading: busy, disabled: !files }}
          propsButtonCancel={{ disabled: busy }}
        />
      </Dialog>
      <Dialog
        open={Boolean(mcp)}
        onOpenChange={(open) => {
          if (!open && !busy) setMcp(null);
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header caption={mcp?.name} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            {scope}
            <Text>
              {s(
                "Регистрация не запускает процесс. Локальные инструменты доступны только в рабочей папке этого устройства; значения env-секретов остаются на компьютере.",
                "Registration does not start a process. Local tools require a workspace on this device; env secret values stay on this computer.",
              )}
            </Text>
            <pre className="skill-preview">
              {JSON.stringify(
                {
                  transport: mcp?.transport,
                  command: mcp?.command,
                  endpoint: mcp?.endpoint,
                  allowedTools: mcp?.allowedTools,
                  cwd: mcp?.cwd,
                  envRefs: mcp?.envRefs,
                },
                null,
                2,
              )}
            </pre>
            {error && <Alert theme="danger" message={error} />}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          onClickButtonCancel={() => {
            if (!busy) setMcp(null);
          }}
          textButtonApply={s("Подключить", "Connect")}
          onClickButtonApply={() => void importMcp()}
          propsButtonApply={{ loading: busy }}
          propsButtonCancel={{ disabled: busy }}
        />
      </Dialog>
    </Flex>
  );
}
