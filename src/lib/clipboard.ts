// Clipboard đáng tin cho Tauri: dùng plugin clipboard-manager (ghi qua Rust,
// hoạt động ổn trên WebKitGTK), fallback về navigator.clipboard khi chạy ngoài
// Tauri (dev web). Mọi thao tác copy trong app nên đi qua đây.
import { writeText as tauriWrite, readText as tauriRead } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
  try {
    await tauriWrite(text);
    return;
  } catch {
    /* ngoài Tauri hoặc plugin lỗi → thử API trình duyệt */
  }
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* bỏ qua */
  }
}

export async function readClipboard(): Promise<string> {
  try {
    return await tauriRead();
  } catch {
    /* fallback */
  }
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}
