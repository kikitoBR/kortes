// The page's only door to Windows: pick the cuts' folder and open it in Explorer.
// Nothing else of Node or Electron reaches the page (sandboxed, context-isolated).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kortesDesktop", {
  pickFolder: (current) => ipcRenderer.invoke("kortes:pick-folder", typeof current === "string" ? current : ""),
  openFolder: (folder) => ipcRenderer.invoke("kortes:open-folder", typeof folder === "string" ? folder : ""),
});
