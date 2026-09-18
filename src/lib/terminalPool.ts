// Pool terminal: mỗi panel (theo panelId) có MỘT xterm + phiên SSH sống độc lập
// với vòng đời React của pane. Nhờ vậy khi đổi workspace/di chuyển (pane bị
// unmount khỏi DOM) phiên SSH KHÔNG bị ngắt — chỉ gỡ DOM ra, gắn lại sau.
// Chỉ khi panel bị ĐÓNG hẳn (release) mới ngắt phiên và dispose.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api, base64ToBytes, SshClosedPayload, SshDataPayload, SshLatencyPayload } from "./ipc";
import { confirmDialog } from "./dialogs";
import { activeSessions } from "./broadcast";
import { resolveTheme } from "./themes";
import { copyText } from "./clipboard";
import { useStore } from "../store";
import "@xterm/xterm/css/xterm.css";

interface Entry {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ro: ResizeObserver | null;
  opened: boolean;
  handlersSet: boolean; // onData/onResize/keys chỉ gắn 1 lần
  sessionId: string | null;
  disposed: boolean;
  connUnlisteners: UnlistenFn[]; // listener theo từng lần kết nối (clear khi reconnect)
  hostId: string;
  badge: HTMLDivElement | null; // hiển thị độ trễ ping ở góc pane
  // "Chờ shell sẵn sàng": đệm phím tới khi output init của shell im một nhịp.
  ready: boolean;
  pending: string[];
  quietTimer: number | null;
  maxTimer: number | null;
}

const pool = new Map<string, Entry>();

// Coi shell là "sẵn sàng" khi output ngưng QUIET_MS; tối đa chờ MAX_MS rồi mở khoá.
const READY_QUIET_MS = 350;
const READY_MAX_MS = 3000;

function clearReadyTimers(entry: Entry) {
  if (entry.quietTimer != null) { window.clearTimeout(entry.quietTimer); entry.quietTimer = null; }
  if (entry.maxTimer != null) { window.clearTimeout(entry.maxTimer); entry.maxTimer = null; }
}

// Shell đã im/đủ lâu → cho gõ: xả toàn bộ phím đã đệm vào phiên.
function markReady(entry: Entry) {
  if (entry.ready) return;
  entry.ready = true;
  clearReadyTimers(entry);
  const buffered = entry.pending.join("");
  entry.pending = [];
  if (buffered && entry.sessionId && !entry.disposed) api.sshSend(entry.sessionId, buffered);
}

// Mỗi lần có output init → dời lại mốc "im lặng".
function bumpQuiet(entry: Entry) {
  if (entry.ready) return;
  if (entry.quietTimer != null) window.clearTimeout(entry.quietTimer);
  entry.quietTimer = window.setTimeout(() => markReady(entry), READY_QUIET_MS);
}

// ----- Báo trạng thái kết nối cho UI (popup Connecting / Failed) -----
// "closed" = shell tự thoát (user gõ exit) → App đóng pane.
export type ConnState = "connecting" | "connected" | "failed" | "closed";
export interface ConnStatus {
  panelId: string;
  hostId: string;
  state: ConnState;
  error?: string;
  attempt?: number; // lần thử hiện tại (khi đang reconnect)
  maxAttempts?: number;
}
let statusCb: ((s: ConnStatus) => void) | null = null;
export function onStatus(cb: (s: ConnStatus) => void) {
  statusCb = cb;
}
function emit(entry: Entry, panelId: string, state: ConnState, error?: string, attempt?: number, maxAttempts?: number) {
  statusCb?.({ panelId, hostId: entry.hostId, state, error, attempt, maxAttempts });
}

// Số lần thử lại + khoảng chờ (tăng dần) khi kết nối lỗi / mất mạng.
const CONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = [1500, 3000, 5000];
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export function acquire(
  panelId: string,
  hostId: string,
  themeName: string | null,
  fontSize: number | null
): Entry {
  const existing = pool.get(panelId);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "relative box-border h-full w-full p-1.5";

  // Badge độ trễ ping ở góc trên-phải (overlay, không chắn thao tác).
  const badge = document.createElement("div");
  badge.className =
    "pointer-events-none absolute right-2.5 top-2.5 z-10 rounded-md px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-0 transition-opacity";
  badge.style.background = "rgba(0,0,0,0.55)";
  el.appendChild(badge);

  const s = useStore.getState();
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
    fontSize: fontSize || s.termFontSize || 13.5,
    cursorBlink: true,
    theme: resolveTheme(themeName || s.termTheme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const entry: Entry = {
    el, term, fit, ro: null, opened: false, handlersSet: false,
    sessionId: null, disposed: false, connUnlisteners: [], hostId, badge,
    ready: true, pending: [], quietTimer: null, maxTimer: null,
  };
  pool.set(panelId, entry);
  return entry;
}

/** Gắn terminal vào một điểm mount (pane). Lần đầu sẽ mở xterm + kết nối SSH. */
export function attach(panelId: string, mount: HTMLElement) {
  const entry = pool.get(panelId);
  if (!entry || entry.disposed) return;
  if (entry.el.parentElement !== mount) mount.appendChild(entry.el);

  if (!entry.opened) {
    entry.term.open(entry.el);
    entry.opened = true;
    entry.ro = new ResizeObserver(() => {
      try {
        entry.fit.fit();
      } catch {
        /* container 0px khi ẩn */
      }
    });
    entry.ro.observe(entry.el);
    safeFit(entry);
    connect(panelId, entry);
  } else {
    // Gắn lại sau khi bị gỡ (đổi workspace): fit + refresh để vẽ lại nội dung.
    requestAnimationFrame(() => {
      safeFit(entry);
      try {
        entry.term.refresh(0, entry.term.rows - 1);
      } catch {
        /* ignore */
      }
    });
  }
  entry.term.focus();
}

/** Gỡ terminal khỏi DOM nhưng GIỮ phiên sống (dùng khi đổi workspace/ẩn pane). */
export function detach(panelId: string, mount: HTMLElement) {
  const entry = pool.get(panelId);
  if (!entry) return;
  if (entry.el.parentElement === mount) mount.removeChild(entry.el);
}

/** Đóng hẳn: ngắt phiên SSH + dispose xterm + xóa khỏi pool. */
export function release(panelId: string) {
  const entry = pool.get(panelId);
  if (!entry) return;
  entry.disposed = true;
  clearReadyTimers(entry);
  entry.ro?.disconnect();
  entry.connUnlisteners.forEach((u) => u());
  if (entry.sessionId) {
    activeSessions.delete(entry.sessionId);
    api.sshDisconnect(entry.sessionId).catch(() => {});
  }
  try {
    entry.term.dispose();
  } catch {
    /* ignore */
  }
  entry.el.remove();
  pool.delete(panelId);
}

/** Thử kết nối lại (nút Retry ở popup). */
export function reconnect(panelId: string) {
  const entry = pool.get(panelId);
  if (!entry || entry.disposed) return;
  entry.term.write("\r\n");
  connect(panelId, entry);
}

// Bộ gõ tiếng Việt (ibus-bamboo/unikey…) hay chèn NBSP (U+00A0) thay cho space
// và các ký tự zero-width vào chuỗi commit → shell nhận "htop " → not found.
// Chuẩn hoá: NBSP các loại → space thường; bỏ zero-width. Chữ Việt bình thường
// (á, ế, đ…) không bị đụng.
function sanitizeImeInput(s: string): string {
  return s
    .replace(/[   ]/g, " ")
    .replace(/[​‌‍⁠﻿]/g, "");
}

// Cập nhật badge độ trễ: xanh <80ms, vàng <200ms, đỏ nếu cao hơn.
function setLatency(entry: Entry, ms: number) {
  const b = entry.badge;
  if (!b) return;
  b.textContent = `${ms} ms`;
  b.style.color = ms < 80 ? "#34d399" : ms < 200 ? "#fbbf24" : "#f87171";
  b.style.opacity = "0.85";
}
// Trạng thái đang đo / mất kết nối.
function pendingLatency(entry: Entry) {
  const b = entry.badge;
  if (!b) return;
  b.textContent = "···";
  b.style.color = "#94a3b8";
  b.style.opacity = "0.6";
}

function safeFit(entry: Entry) {
  try {
    entry.fit.fit();
  } catch {
    /* ignore */
  }
}

// Gắn các handler bàn phím / gõ / resize MỘT LẦN. Chúng đọc entry.sessionId hiện tại
// nên vẫn đúng sau khi reconnect (đổi session id).
function setupHandlers(entry: Entry) {
  if (entry.handlersSet) return;
  entry.handlersSet = true;
  const term = entry.term;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      const sel = term.getSelection();
      if (sel) {
        copyText(sel);
        return false;
      }
    }
    return true;
  });
  term.onData((raw) => {
    if (!entry.sessionId) return;
    const st = useStore.getState();
    const d = st.sanitizeInput ? sanitizeImeInput(raw) : raw;
    if (!entry.ready) { entry.pending.push(d); return; } // đang chờ shell sẵn sàng
    if (st.broadcast) {
      for (const sid of activeSessions) api.sshSend(sid, d);
    } else {
      api.sshSend(entry.sessionId, d);
    }
  });
  term.onResize(({ cols, rows }) => {
    if (entry.sessionId) api.sshResize(entry.sessionId, cols, rows);
  });
}

async function connect(panelId: string, entry: Entry): Promise<void> {
  const term = entry.term;
  setupHandlers(entry);

  // Dọn kết nối cũ (trường hợp reconnect).
  entry.connUnlisteners.forEach((u) => u());
  entry.connUnlisteners = [];
  if (entry.sessionId) {
    activeSessions.delete(entry.sessionId);
    api.sshDisconnect(entry.sessionId).catch(() => {});
    entry.sessionId = null;
  }

  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    if (entry.disposed) return;
    emit(entry, panelId, "connecting", undefined, attempt, CONNECT_MAX_ATTEMPTS);
    pendingLatency(entry); // badge "···" khi đang (re)connect

    try {
    const id = await api.sshConnect(entry.hostId, term.cols, term.rows);
    if (entry.disposed) {
      api.sshDisconnect(id).catch(() => {});
      return;
    }
    entry.sessionId = id;
    activeSessions.add(id);

    // Chờ shell sẵn sàng: đệm phím tới khi output init "im" (READY_QUIET_MS) hoặc
    // hết READY_MAX_MS. Tắt tùy chọn → cho gõ ngay.
    clearReadyTimers(entry);
    entry.pending = [];
    if (useStore.getState().shellReadyWait) {
      entry.ready = false;
      bumpQuiet(entry);
      entry.maxTimer = window.setTimeout(() => markReady(entry), READY_MAX_MS);
    } else {
      entry.ready = true;
    }

    entry.connUnlisteners.push(
      await listen<SshDataPayload>("ssh:data", (e) => {
        if (e.payload.id === id) {
          term.write(base64ToBytes(e.payload.data));
          bumpQuiet(entry); // có output init → dời mốc "im lặng"
        }
      })
    );
    entry.connUnlisteners.push(
      await listen<SshLatencyPayload>("ssh:latency", (e) => {
        if (e.payload.id === id) setLatency(entry, e.payload.ms);
      })
    );
    entry.connUnlisteners.push(
      await listen<SshClosedPayload>("ssh:closed", (e) => {
        if (e.payload.id !== id || entry.disposed) return;
        entry.sessionId = null;
        activeSessions.delete(id);
        if (e.payload.clean) {
          // Shell tự thoát (user gõ `exit`) → báo App đóng pane.
          emit(entry, panelId, "closed");
        } else {
          // Đứt ngang (mất mạng…) → tự kết nối lại vài lần.
          term.write("\r\n\x1b[33m[connection lost — reconnecting…]\x1b[0m\r\n");
          connect(panelId, entry);
        }
      })
    );

    term.focus();
    emit(entry, panelId, "connected");
    return; // thành công
  } catch (err) {
    const str = String(err);
    if (str.startsWith("HOSTKEY|")) {
      const parts = str.split("|");
      const [, kind, addr, port, algo, fp] = parts;
      const openssh = parts.slice(6).join("|");
      const changed = kind === "changed";
      const ok = await confirmDialog({
        title: changed ? "⚠ Host key CHANGED" : "Unknown host key",
        message: changed
          ? `WARNING: the host key for ${addr}:${port} has CHANGED.\nThis could be a man-in-the-middle attack, or the server was reinstalled.\n\nType: ${algo}\nFingerprint: ${fp}\n\nAccept the new key only if you trust it.`
          : `The authenticity of ${addr}:${port} can't be established.\n\nType: ${algo}\nFingerprint: ${fp}\n\nTrust this host and remember its key?`,
        confirmText: changed ? "Accept new key" : "Trust",
        danger: changed,
      });
      if (ok && !entry.disposed) {
        try {
          await api.knownHostsAdd(addr, Number(port), algo, openssh, fp);
          await connect(panelId, entry);
        } catch (e2) {
          emit(entry, panelId, "failed", `Error saving host key: ${e2}`);
        }
        return;
      }
      emit(entry, panelId, "failed", "Host key not trusted — connection aborted.");
      return;
    }
    // Lỗi mạng/khác → thử lại vài lần (backoff) rồi mới báo fail.
    if (attempt < CONNECT_MAX_ATTEMPTS && !entry.disposed) {
      term.write(`\r\n\x1b[33m[connect failed — retrying ${attempt + 1}/${CONNECT_MAX_ATTEMPTS}…]\x1b[0m\r\n`);
      await sleep(RECONNECT_DELAY_MS[attempt - 1] ?? 3000);
      continue;
    }
    term.write(`\r\n\x1b[31mConnection error: ${err}\x1b[0m\r\n`);
    emit(entry, panelId, "failed", str);
    return;
    }
  }
}
