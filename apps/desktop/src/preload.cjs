const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "runozaDesktop",
  Object.freeze({
    platform: process.platform,
    status: () => ipcRenderer.invoke("desktop:status"),
    connect: (url) => ipcRenderer.invoke("desktop:connect", url),
    localExtensions: () => ipcRenderer.invoke("desktop:extensions:list"),
    readLocalSkill: (id) => ipcRenderer.invoke("desktop:extensions:read", id),
    chooseFolder: () => ipcRenderer.invoke("desktop:folder"),
  }),
);
