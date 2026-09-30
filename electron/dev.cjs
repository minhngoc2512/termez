// SPIKE: chạy Vite (cổng 1520, khác cổng 1420 của bản Tauri) rồi mở Electron.
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const PORT = 1520;
const bin = (n) => path.join(root, "node_modules", ".bin", n);

const vite = spawn(bin("vite"), ["--port", String(PORT), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
let started = false;
vite.stdout.on("data", (d) => {
  process.stdout.write(d);
  if (!started && /Local:/.test(String(d))) {
    started = true;
    const el = spawn(bin("electron"), ["."], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, TZ_DEV_URL: `http://localhost:${PORT}` },
    });
    el.on("exit", (code) => {
      vite.kill();
      process.exit(code ?? 0);
    });
  }
});
process.on("SIGINT", () => vite.kill());
