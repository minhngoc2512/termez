// Pool terminal: mỗi panel (theo panelId) có MỘT xterm + phiên SSH sống độc lập
// với vòng đời React của pane. Nhờ vậy khi đổi workspace/di chuyển (pane bị
// unmount khỏi DOM) phiên SSH KHÔNG bị ngắt — chỉ gỡ DOM ra, gắn lại sau.
// Chỉ khi panel bị ĐÓNG hẳn (release) mới ngắt phiên và dispose.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api, base64ToBytes, SshClosedPayload, SshDataPayload } from "./ipc";
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
}

const pool = new Map<string, Entry>();

// ----- Báo trạng thái kết nối cho UI (popup Connecting / Failed) -----
export type ConnState = "connecting" | "connected" | "failed";
export interface ConnStatus {
  panelId: string;
  hostId: string;
  state: ConnState;
  error?: string;
}
let statusCb: ((s: ConnStatus) => void) | null = null;
export function onStatus(cb: (s: ConnStatus) => void) {
  statusCb = cb;
}
function emit(entry: Entry, panelId: string, state: ConnState, error?: string) {
  statusCb?.({ panelId, hostId: entry.hostId, state, error });
}

export function acquire(
  panelId: string,
  hostId: string,
  themeName: string | null,
  fontSize: number | null
): Entry {
  const existing = pool.get(panelId);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "box-border h-full w-full p-1.5";

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
    sessionId: null, disposed: false, connUnlisteners: [], hostId,
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
  term.onData((d) => {
    if (!entry.sessionId) return;
    if (useStore.getState().broadcast) {
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

  emit(entry, panelId, "connecting");

  try {
    const id = await api.sshConnect(entry.hostId, term.cols, term.rows);
    if (entry.disposed) {
      api.sshDisconnect(id).catch(() => {});
      return;
    }
    entry.sessionId = id;
    activeSessions.add(id);

    entry.connUnlisteners.push(
      await listen<SshDataPayload>("ssh:data", (e) => {
        if (e.payload.id === id) term.write(base64ToBytes(e.payload.data));
      })
    );
    entry.connUnlisteners.push(
      await listen<SshClosedPayload>("ssh:closed", (e) => {
        if (e.payload.id === id) term.write("\r\n\x1b[33m[session closed]\x1b[0m\r\n");
      })
    );

    term.focus();
    emit(entry, panelId, "connected");
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
    term.write(`\r\n\x1b[31mConnection error: ${err}\x1b[0m\r\n`);
    emit(entry, panelId, "failed", str);
  }
}
