// Build bộ cài Termez (Electron) cho nền tảng đang chạy.
//
//   node electron/build.cjs                  # mọi target mặc định của nền tảng
//   node electron/build.cjs --linux deb      # tham số sau được chuyển cho electron-builder
//
// Các bước: kiểm tra version → build giao diện (Vite) → build module native (Rust,
// napi) → build sidecar kdbx-import → dựng thư mục staging gọn (không kéo
// node_modules vào gói vì giao diện đã được Vite đóng gói) → electron-builder.
// macOS: module native và sidecar được build cho cả aarch64 + x86_64 rồi `lipo`
// thành universal.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(ROOT, ".electron-app"); // app gói vào asar
const EXTRA = path.join(ROOT, ".electron-extra"); // file đặt cạnh file chạy (sidecar)
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: isWin, ...opts });
}

// ---- 1. Version phải khớp: package.json ↔ native/Cargo.toml (app_version đọc Cargo) ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const cargoVer = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(ROOT, "native", "Cargo.toml"), "utf8"))[1];
if (cargoVer !== pkg.version) {
  console.error(`!! Version lệch: package.json=${pkg.version}, native/Cargo.toml=${cargoVer}`);
  process.exit(1);
}
console.log(`==> Termez ${pkg.version} (${process.platform})`);

// ---- 2. Giao diện ----
run("pnpm", ["build"]);

// ---- 3 + 4. Module native + sidecar ----
function cargoBuild(manifest, target) {
  const args = ["build", "--release", "--manifest-path", manifest];
  if (target) args.push("--target", target);
  run("cargo", args);
}
function lipo(inputs, output) {
  run("lipo", ["-create", ...inputs, "-output", output]);
}
// Ghi file mới rồi đổi tên (inode mới) thay vì ghi đè tại chỗ: nếu một tiến trình
// (vd `pnpm electron:dev`) đang nạp thư viện này, ghi đè tại chỗ sẽ làm nó SIGSEGV.
function replaceFile(src, dest) {
  fs.copyFileSync(src, dest + ".tmp");
  fs.renameSync(dest + ".tmp", dest);
}

const NATIVE = path.join(ROOT, "native");
const nativeManifest = path.join(NATIVE, "Cargo.toml");
const nativeOut = path.join(NATIVE, "termez_native.node");
const SIDECAR = path.join(ROOT, "src-tauri", "sidecar", "kdbx-import");
const sidecarManifest = path.join(SIDECAR, "Cargo.toml");
const sidecarName = isWin ? "kdbx-import.exe" : "kdbx-import";

fs.rmSync(EXTRA, { recursive: true, force: true });
fs.mkdirSync(EXTRA, { recursive: true });

if (isMac) {
  const triples = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  for (const t of triples) {
    cargoBuild(nativeManifest, t);
    cargoBuild(sidecarManifest, t);
  }
  lipo(triples.map((t) => path.join(NATIVE, "target", t, "release", "libtermez_native.dylib")), nativeOut + ".tmp");
  fs.renameSync(nativeOut + ".tmp", nativeOut);
  lipo(triples.map((t) => path.join(SIDECAR, "target", t, "release", "kdbx-import")), path.join(EXTRA, sidecarName));
} else {
  cargoBuild(nativeManifest);
  cargoBuild(sidecarManifest);
  const lib = isWin ? "termez_native.dll" : "libtermez_native.so";
  replaceFile(path.join(NATIVE, "target", "release", lib), nativeOut);
  fs.copyFileSync(path.join(SIDECAR, "target", "release", sidecarName), path.join(EXTRA, sidecarName));
}

// ---- 5. Staging: chỉ những gì app cần lúc chạy ----
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "electron"), { recursive: true });
fs.mkdirSync(path.join(STAGE, "native"), { recursive: true });
for (const f of ["main.cjs", "preload.cjs"]) {
  fs.copyFileSync(path.join(__dirname, f), path.join(STAGE, "electron", f));
}
fs.copyFileSync(nativeOut, path.join(STAGE, "native", "termez_native.node"));
fs.cpSync(path.join(ROOT, "dist"), path.join(STAGE, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: "termez",
      productName: "Termez",
      version: pkg.version,
      description: "Termez — SSH/SFTP manager",
      homepage: "https://minhngoc2512.github.io/termez/",
      author: { name: "Termez", email: "termez@users.noreply.github.com" },
      license: "UNLICENSED",
      main: "electron/main.cjs",
    },
    null,
    2
  )
);

// ---- 6. electron-builder ----
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "electron", "package.json"), "utf8")
).version;
run(path.join(ROOT, "node_modules", ".bin", isWin ? "electron-builder.cmd" : "electron-builder"), [
  "--config",
  "electron-builder.yml",
  `-c.electronVersion=${electronVersion}`,
  "--publish",
  "never",
  ...process.argv.slice(2),
]);
console.log(`\n==> Xong. Bộ cài trong ${path.join(ROOT, "release")}`);
