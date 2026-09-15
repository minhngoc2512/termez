import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { api, base64ToBytes, SshClosedPayload, SshDataPayload } from "../lib/ipc";
import { activeSessions } from "../lib/broadcast";
import { resolveTheme } from "../lib/themes";
import { useStore } from "../store";

interface Props {
  hostId: string;
  themeName?: string | null;
  fontSize?: number | null;
}

/**
 * Một terminal SSH độc lập. Kết nối khi mount, ngắt khi unmount (pane bị đóng).
 * dockview giữ nguyên instance khi kéo/di chuyển pane nên phiên không bị ngắt lúc đó.
 */
export function TerminalView({ hostId, themeName, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let sessionId: string | null = null;
    const unlisteners: UnlistenFn[] = [];

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: fontSize || 13.5,
      cursorBlink: true,
      theme: resolveTheme(themeName),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container tạm thời 0px khi pane ẩn */
      }
    });
    ro.observe(containerRef.current);

    // Copy: Ctrl+Shift+C (khi có vùng chọn). Paste (Ctrl+Shift+V) để xterm/webkit
    // xử lý mặc định — nó đi qua onData nên vẫn tôn trọng Broadcast, tránh gửi 2 lần.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
      }
      return true;
    });

    (async () => {
      try {
        const id = await api.sshConnect(hostId, term.cols, term.rows);
        if (disposed) {
          api.sshDisconnect(id).catch(() => {});
          return;
        }
        sessionId = id;
        activeSessions.add(id);

        unlisteners.push(
          await listen<SshDataPayload>("ssh:data", (e) => {
            if (e.payload.id === id) term.write(base64ToBytes(e.payload.data));
          })
        );
        unlisteners.push(
          await listen<SshClosedPayload>("ssh:closed", (e) => {
            if (e.payload.id === id) term.write("\r\n\x1b[33m[session closed]\x1b[0m\r\n");
          })
        );

        term.onData((d) => {
          // Broadcast: gõ 1 lần, gửi tới mọi phiên đang mở.
          if (useStore.getState().broadcast) {
            for (const sid of activeSessions) api.sshSend(sid, d);
          } else {
            api.sshSend(id, d);
          }
        });
        term.onResize(({ cols, rows }) => api.sshResize(id, cols, rows));
        term.focus();
      } catch (err) {
        term.write(`\r\n\x1b[31mConnection error: ${err}\x1b[0m\r\n`);
      }
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      if (sessionId) {
        activeSessions.delete(sessionId);
        api.sshDisconnect(sessionId).catch(() => {});
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="h-full w-full p-1.5" ref={containerRef} />;
}
