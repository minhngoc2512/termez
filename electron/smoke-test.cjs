// Smoke test bản ĐÃ ĐÓNG GÓI (Linux): chạy release/linux-unpacked/termez với thư
// mục dữ liệu tạm (không đụng dữ liệu thật), rồi qua cổng debug kiểm tra giao
// diện thật sự được vẽ ra. Bắt lỗi kiểu "cửa sổ mở nhưng màn hình đen" (vd asset
// sai đường dẫn) mà việc chỉ kiểm tra tiến trình còn sống không phát hiện được.
//
//   node electron/smoke-test.cjs          # cần màn hình; trên CI: xvfb-run -a node …
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "release", "linux-unpacked", "termez");
const PORT = 9350;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "termez-smoke-"));

const app = spawn(BIN, [`--remote-debugging-port=${PORT}`, "--no-sandbox"], {
  env: { ...process.env, XDG_DATA_HOME: path.join(tmp, "data"), XDG_CONFIG_HOME: path.join(tmp, "config") },
  stdio: ["ignore", "inherit", "inherit"],
});

let done = false;
function finish(code, msg) {
  if (done) return; // chỉ kết thúc MỘT lần (tắt app sẽ bắn thêm sự kiện "exit")
  done = true;
  console.log(msg);
  app.removeAllListeners("exit");
  app.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true }); // app có thể còn đang ghi khi bị tắt
  } catch {
    /* dọn không được thì thôi — thư mục tạm */
  }
  process.exit(code);
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  return new Promise((res) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) {
        ws.close();
        res(d.result && d.result.result && d.result.result.value);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}

(async () => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((p) => p.type === "page");
      if (!page) continue;
      const state = await evaluate(
        page.webSocketDebuggerUrl,
        'JSON.stringify({ root: document.getElementById("root")?.childElementCount || 0, text: document.body.innerText.slice(0, 200) })'
      );
      const { root, text } = JSON.parse(state || "{}");
      if (root > 0 && /Termez/.test(text) && /Hosts/.test(text)) {
        return finish(0, `✓ Giao diện đã vẽ ra (${text.split("\n").slice(0, 4).join(" | ")})`);
      }
    } catch {
      /* app chưa sẵn sàng — thử lại */
    }
  }
  finish(1, "✗ Sau 45s giao diện vẫn chưa hiện (màn hình trắng/đen?)");
})();

app.on("exit", (code) => finish(1, `✗ App thoát sớm (mã ${code})`));
