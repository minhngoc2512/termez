// Cầu nối tối thiểu giữa giao diện và tiến trình chính (contextIsolation + sandbox).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("tzElectron", {
  invoke: (cmd, args) => ipcRenderer.invoke("tz:invoke", cmd, args),
  onChannel: (cb) => ipcRenderer.on("tz:channel", (_e, m) => cb(m)),
  onEvent: (cb) => ipcRenderer.on("tz:event", (_e, m) => cb(m)),
  // Đường dẫn thật của file kéo từ hệ điều hành vào (upload Storage).
  pathForFile: (file) => webUtils.getPathForFile(file),
});
