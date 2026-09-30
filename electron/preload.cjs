// SPIKE: cầu nối tối thiểu giữa giao diện và tiến trình chính (contextIsolation).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tzElectron", {
  invoke: (cmd, args) => ipcRenderer.invoke("tz:invoke", cmd, args),
  onChannel: (cb) => ipcRenderer.on("tz:channel", (_e, m) => cb(m)),
  onEvent: (cb) => ipcRenderer.on("tz:event", (_e, m) => cb(m)),
});
