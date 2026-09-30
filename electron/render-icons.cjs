// Xuất icon PNG từ SVG bằng Chromium của Electron (giữ nền trong suốt, vẽ chuẩn).
//   node_modules/.bin/electron electron/render-icons.cjs
// Đầu vào: electron/resources/logo.svg, logo-mac.svg → icon.png, icon-mac.png (1024px),
// cùng bản xem trước cỡ nhỏ trong electron/resources/preview/.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const RES = path.join(__dirname, "resources");
const jobs = [
  ["logo.svg", "icon.png", 1024],
  ["logo-mac.svg", "icon-mac.png", 1024],
  ...[16, 32, 64, 128].map((s) => ["logo.svg", path.join("preview", `icon-${s}.png`), s]),
  // Bộ icon Linux theo các cỡ chuẩn của theme hicolor (không có 1024 → phải đủ cỡ, nếu
  // không menu ứng dụng sẽ không tìm thấy icon). electron-builder: linux.icon = thư mục này.
  ...[16, 24, 32, 48, 64, 128, 256, 512].map((s) => ["logo.svg", path.join("linux-icons", `${s}x${s}.png`), s]),
];

// Một cửa sổ offscreen dùng lại cho mọi cỡ (tạo/huỷ liên tục dễ làm lỗi nạp trang).
let win;
const tmpHtml = path.join(require("node:os").tmpdir(), "termez-icon-render.html");

async function render(svgFile, size) {
  const svg = fs.readFileSync(path.join(RES, svgFile));
  fs.writeFileSync(
    tmpHtml,
    `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg.toString("base64")}" width="${size}" height="${size}"></body></html>`
  );
  win.setContentSize(size, size);
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: "best" }).toPNG();
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false, width: 1024, height: 1024, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  fs.mkdirSync(path.join(RES, "preview"), { recursive: true });
  fs.mkdirSync(path.join(RES, "linux-icons"), { recursive: true });
  for (const [src, out, size] of jobs) {
    fs.writeFileSync(path.join(RES, out), await render(src, size));
    console.log(`✓ ${out} (${size}px)`);
  }
  fs.rmSync(tmpHtml, { force: true });
  app.quit();
});
