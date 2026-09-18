import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// Chặn menu chuột phải mặc định của WebView (Reload/Inspect… — lộ là app webview).
// Vẫn chừa ô nhập liệu để chuột phải dán được; menu tùy biến (task tab) tự vẽ
// bằng React portal nên không phụ thuộc menu native này.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
