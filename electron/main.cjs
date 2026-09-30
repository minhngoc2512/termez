// SPIKE: vỏ Electron cho Termez. Giao diện React giữ nguyên; backend Rust chạy
// trong tiến trình chính qua module napi (native/termez_native.node).
// Mục đích duy nhất: đo độ mượt terminal khi vẽ bằng Chromium thay vì WebKitGTK.
const { app, BrowserWindow, ipcMain, shell, clipboard } = require("electron");
const path = require("node:path");
const os = require("node:os");
const native = require("../native/termez_native.node");

// Dùng CHUNG dữ liệu với bản Tauri (host, known_hosts…); secret vẫn ở keychain.
const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "com.termez.app"
);
const DB_PATH = path.join(DATA_DIR, "termez.db");
const DEV_URL = process.env.TZ_DEV_URL; // vd http://localhost:1520 khi chạy dev

let win = null;

function send(channel, msg) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, msg);
}
function emitEvent(event, payload) {
  send("tz:event", { event, payload });
}

const VERSION = "0.2.21-electron-spike";

// Lệnh trả lời ngay ở đây (không cần backend) để giao diện khởi động êm.
const LOCAL = {
  app_version: () => VERSION,
  check_update: () => ({ current: VERSION, latest: VERSION, has_update: false, url: "", notes: "" }),
  release_notes: () => "",
  render_status: () => ({ supported: false, dmabuf: false, trial: false, env_forced: false }),
  sync_get_config: () => ({ repo: null, has_pat: false, auto: false }),
  sync_auto_pull: () => "disabled",
  tunnel_active: () => [],
  get_buckets: () => [],
};

// Output SSH → đúng Channel của pane (giữ thứ tự bằng index như Tauri Channel).
async function sshConnect({ hostId, cols, rows, onData }) {
  const channelId = Number(String(onData).split(":")[1]);
  let index = 0;
  const holder = { sid: null, queue: [] };
  const fire = (ev) =>
    ev.type === "latency"
      ? emitEvent("ssh:latency", { id: holder.sid, ms: ev.ms })
      : emitEvent("ssh:closed", { id: holder.sid, clean: ev.clean });
  const sid = await native.sshConnect(
    hostId,
    cols,
    rows,
    (buf) => send("tz:channel", { id: channelId, index: index++, message: buf }),
    (json) => {
      const ev = JSON.parse(json);
      if (holder.sid) fire(ev);
      else holder.queue.push(ev); // sự kiện tới trước khi có session id
    }
  );
  holder.sid = sid;
  holder.queue.splice(0).forEach(fire);
  return sid;
}

async function handle(cmd, args) {
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
    case "plugin:clipboard-manager|write_text":
      return clipboard.writeText(args.text ?? "");
    case "plugin:clipboard-manager|read_text":
      return clipboard.readText();
    case "ssh_connect":
      return sshConnect(args);
    case "ssh_send":
      return native.sshSend(args.id, args.data);
    case "ssh_resize":
      return native.sshResize(args.id, args.cols, args.rows);
    case "ssh_disconnect":
      return native.sshDisconnect(args.id);
  }
  if (cmd in LOCAL) return LOCAL[cmd](args);
  return JSON.parse(await native.invoke(cmd, JSON.stringify(args ?? {})));
}

// Lỗi trả về dạng { __err } để phía giao diện ném lại đúng CHUỖI như Tauri
// (vd "HOSTKEY|…"), thay vì Error có tiền tố của Electron.
ipcMain.handle("tz:invoke", async (_e, cmd, args) => {
  try {
    return { ok: await handle(cmd, args) };
  } catch (err) {
    return { __err: String(err && err.message ? err.message : err) };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    frame: false, // giống bản Tauri (decorations: false, TitleBar tự vẽ)
    backgroundColor: "#0b1120",
    title: "Termez (Electron spike)",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // SPIKE: đẩy cảnh báo/lỗi của giao diện ra terminal để dễ gỡ lỗi.
  win.webContents.on("console-message", (e) => {
    if (e.level === "warning" || e.level === "error") console.log(`[renderer ${e.level}] ${e.message}`);
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(async () => {
  await native.init(DB_PATH);
  createWindow();
  // SPIKE: in trạng thái tăng tốc GPU của Chromium (để biết đang vẽ bằng GPU hay phần mềm).
  setTimeout(() => {
    const s = app.getGPUFeatureStatus();
    console.log("[gpu]", JSON.stringify({ gpu_compositing: s.gpu_compositing, webgl: s.webgl, rasterization: s.rasterization }));
  }, 4000);
});
app.on("window-all-closed", () => app.quit());
