// Cầu nối tối thiểu giữa giao diện và tiến trình chính (contextIsolation + sandbox).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Lần đầu mở bản Electron: điền tuỳ chọn giao diện chuyển từ bản Tauri vào
// localStorage TRƯỚC khi giao diện chạy (store đọc localStorage ngay lúc nạp).
// Chỉ điền khoá còn trống — không đè tuỳ chọn đã chỉnh trong bản Electron.
try {
  const prefs = ipcRenderer.sendSync("tz:take-prefs");
  if (prefs) {
    for (const [k, v] of Object.entries(prefs)) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  }
} catch {
  /* không chuyển được thì thôi — dùng tuỳ chọn mặc định */
}

contextBridge.exposeInMainWorld("tzElectron", {
  invoke: (cmd, args) => ipcRenderer.invoke("tz:invoke", cmd, args),
  onChannel: (cb) => ipcRenderer.on("tz:channel", (_e, m) => cb(m)),
  onEvent: (cb) => ipcRenderer.on("tz:event", (_e, m) => cb(m)),
  // Đường dẫn thật của file kéo từ hệ điều hành vào (upload Storage).
  pathForFile: (file) => webUtils.getPathForFile(file),
});
