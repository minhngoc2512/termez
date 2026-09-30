// Termez trên Electron — tiến trình chính.
//
// Giao diện React giữ nguyên (chạy qua lớp giả lập Tauri: src/lib/electronShim.ts).
// Backend Rust nguyên văn chạy trong tiến trình này qua module napi
// (native/termez_native.node). File này lo:
//   - định tuyến mọi lệnh `invoke` sang backend;
//   - thay các plugin Tauri (cửa sổ, dialog, clipboard, mở link, cửa sổ mới) bằng API Electron;
//   - chuyển sự kiện backend tới mọi cửa sổ, và output Channel tới ĐÚNG cửa sổ sở hữu.
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("node:path");
const os = require("node:os");
const native = require("../native/termez_native.node");

// Dùng ĐÚNG thư mục dữ liệu của bản Tauri (termez.db, sync-base…) để người dùng
// nâng cấp từ Tauri lên không mất gì. Tauri: app_data_dir = <data dir>/<identifier>.
// Secret vẫn ở keychain hệ điều hành (cùng service name) nên cũng giữ nguyên.
function tauriDataDir() {
  const id = "com.termez.app";
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", id);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), id);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), id);
}
const DATA_DIR = tauriDataDir();
const DEV_URL = process.env.TZ_DEV_URL; // vd http://localhost:1520 khi chạy dev

// ---------- Sự kiện backend → mọi cửa sổ ----------

function broadcast(channel, msg) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, msg);
  }
}

function onBackendEvent(json) {
  const { event, payload } = JSON.parse(json);
  if (event === "__termez_restart") {
    app.relaunch();
    app.exit(0);
    return;
  }
  broadcast("tz:event", { event, payload });
}

// ---------- Channel: id toàn cục ↔ (cửa sổ, id cục bộ) ----------
// Mỗi cửa sổ tự đánh số Channel của nó nên id có thể trùng giữa các cửa sổ.
// Main cấp id toàn cục cho backend rồi đổi ngược khi gửi output về.

let nextChannelId = 1;
const channels = new Map(); // globalId → { wc, localId }

function mapChannels(value, wc) {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const gid = nextChannelId++;
    channels.set(gid, { wc, localId: Number(value.slice(12)) });
    return `__CHANNEL__:${gid}`;
  }
  if (Array.isArray(value)) return value.map((v) => mapChannels(v, wc));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapChannels(v, wc);
    return out;
  }
  return value;
}

// Khung nhị phân từ Rust: [id u32][index u64][kind u8: 0 byte thô, 1 JSON][dữ liệu].
function onBackendChannel(buf) {
  const id = buf.readUInt32LE(0);
  const index = Number(buf.readBigUInt64LE(4));
  const kind = buf[12];
  const data = buf.subarray(13);
  const target = channels.get(id);
  if (!target || target.wc.isDestroyed()) return;
  const message = kind === 0 ? data : JSON.parse(data.toString("utf8"));
  target.wc.send("tz:channel", { id: target.localId, index, message });
}

// ---------- Plugin Tauri → API Electron ----------

function dialogFilters(filters) {
  return (filters || []).map((f) => ({ name: f.name, extensions: f.extensions }));
}

async function handlePlugin(cmd, args, win) {
  switch (cmd) {
    case "plugin:window|minimize":
      return win.minimize();
    case "plugin:window|toggle_maximize":
      return win.isMaximized() ? win.unmaximize() : win.maximize();
    case "plugin:window|close":
      return win.close();
    case "plugin:window|is_maximized":
      return win.isMaximized();

    case "plugin:opener|open_url":
      return shell.openExternal(args.url);
    case "plugin:opener|open_path":
      return shell.openPath(args.path);
    case "plugin:opener|reveal_item_in_dir":
      return shell.showItemInFolder((args.paths || [])[0] || "");

    case "plugin:clipboard-manager|write_text":
      return clipboard.writeText(args.text ?? "");
    case "plugin:clipboard-manager|read_text":
      return clipboard.readText();

    case "plugin:dialog|open": {
      const o = args.options || {};
      const properties = [o.directory ? "openDirectory" : "openFile"];
      if (o.multiple) properties.push("multiSelections");
      const r = await dialog.showOpenDialog(win, {
        title: o.title,
        defaultPath: o.defaultPath,
        filters: dialogFilters(o.filters),
        properties,
      });
      if (r.canceled || r.filePaths.length === 0) return null;
      return o.multiple ? r.filePaths : r.filePaths[0];
    }
    case "plugin:dialog|save": {
      const o = args.options || {};
      const r = await dialog.showSaveDialog(win, {
        title: o.title,
        defaultPath: o.defaultPath,
        filters: dialogFilters(o.filters),
      });
      return r.canceled ? null : r.filePath;
    }

    case "plugin:webview|create_webview_window": {
      const o = args.options || {};
      createWindow({ url: o.url, title: o.title, width: o.width, height: o.height });
      return;
    }
  }
  return undefined;
}

// Lệnh chỉ có nghĩa với bản Tauri (DMABUF của WebKitGTK) — Electron không cần.
const ELECTRON_LOCAL = {
  render_status: () => ({ supported: false, dmabuf: false, trial: false, env_forced: false }),
  render_set_dmabuf: () => null,
  render_confirm_dmabuf: () => null,
};

async function handle(cmd, args, win, wc) {
  if (cmd.startsWith("plugin:")) return handlePlugin(cmd, args, win);
  if (cmd in ELECTRON_LOCAL) return ELECTRON_LOCAL[cmd](args);
  const mapped = mapChannels(args ?? {}, wc);
  return JSON.parse(await native.invoke(cmd, JSON.stringify(mapped)));
}

// Lỗi trả về dạng { __err } để phía giao diện ném lại đúng CHUỖI như Tauri
// (vd "HOSTKEY|…"), thay vì Error có tiền tố của Electron.
ipcMain.handle("tz:invoke", async (e, cmd, args) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    return { ok: await handle(cmd, args, win, e.sender) };
  } catch (err) {
    return { __err: String(err && err.message ? err.message : err) };
  }
});

// ---------- Cửa sổ ----------

function createWindow({ url, title, width, height } = {}) {
  const win = new BrowserWindow({
    width: width || 1280,
    height: height || 820,
    frame: false, // giống bản Tauri (decorations: false, TitleBar tự vẽ)
    backgroundColor: "#0b1120",
    title: title || "Termez",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.TZ_DEBUG) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "warning" || e.level === "error") console.log(`[renderer ${e.level}] ${e.message}`);
    });
  }
  // Dọn Channel của cửa sổ khi nó đóng.
  win.webContents.on("destroyed", () => {
    for (const [gid, c] of channels) if (c.wc === win.webContents) channels.delete(gid);
  });

  // url tương đối kiểu "index.html?dup=<hostId>" (Duplicate in a new window).
  const rel = url && !/^[a-z]+:/i.test(url) ? url : "";
  const search = rel.includes("?") ? rel.slice(rel.indexOf("?")) : "";
  if (DEV_URL) win.loadURL(`${DEV_URL}/${search}`);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"), { search });
  return win;
}

app.whenReady().then(async () => {
  await native.init(DATA_DIR, onBackendEvent, onBackendChannel);
  createWindow();
});
app.on("window-all-closed", () => app.quit());
