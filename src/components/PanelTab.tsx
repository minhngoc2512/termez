import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IDockviewPanelHeaderProps } from "dockview-react";
import { X, Copy, Check, CopyPlus, ExternalLink } from "lucide-react";
import { useStore } from "../store";
import { copyText } from "../lib/clipboard";

type TermParams = { hostId?: string; theme?: string | null; fontSize?: number | null };

/**
 * Tab tùy chỉnh cho dockview: hiện tên panel; hover vào tab (nếu là host)
 * bật popup thông tin IP + nút copy IP. Chuột phải mở menu Duplicate.
 */
export function PanelTab(props: IDockviewPanelHeaderProps<TermParams>) {
  const hosts = useStore((s) => s.hosts);
  const hostId = props.params?.hostId;
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;

  const tabRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  function open() {
    if (timer.current) window.clearTimeout(timer.current);
    if (!host) return;
    const r = tabRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left, y: r.bottom + 4 });
  }
  function scheduleClose() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPos(null), 160);
  }

  // Đóng menu khi click/nhấn Esc ra ngoài.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  function onContextMenu(e: React.MouseEvent) {
    if (!hostId) return; // chỉ tab terminal của host mới có menu
    e.preventDefault();
    e.stopPropagation();
    setPos(null);
    setMenu({ x: e.clientX, y: e.clientY });
  }

  // Mở thêm một shell của cùng host trong một tab mới (cùng cửa sổ).
  function duplicate() {
    setMenu(null);
    props.containerApi.addPanel({
      id: crypto.randomUUID(),
      component: "terminal",
      tabComponent: "info",
      title: props.api.title,
      params: { ...(props.params || {}) },
    });
  }

  // Mở một cửa sổ mới, tự khởi tạo terminal cho host này.
  async function duplicateWindow() {
    setMenu(null);
    if (!hostId) return;
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      new WebviewWindow(`term-${crypto.randomUUID().slice(0, 8)}`, {
        url: `index.html?dup=${encodeURIComponent(hostId)}`,
        title: props.api.title || "Termez",
        width: 1000,
        height: 680,
        decorations: false,
      });
    } catch {
      /* ngoài Tauri (dev web) — bỏ qua */
    }
  }

  function copyIp(e: React.MouseEvent) {
    e.stopPropagation();
    if (!host) return;
    copyText(host.address).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div
      ref={tabRef}
      className="flex items-center gap-1.5 px-2"
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onContextMenu={onContextMenu}
    >
      <span className="truncate text-[13px]">{props.api.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        className="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-border hover:text-foreground"
        title="Close"
      >
        <X className="size-3.5" />
      </button>

      {pos &&
        host &&
        createPortal(
          <div
            style={{ position: "fixed", left: pos.x, top: pos.y }}
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
            className="z-[9999] w-64 rounded-lg border border-slate-600 bg-popover p-2.5 text-popover-foreground shadow-2xl"
          >
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Host</div>
            <div className="truncate text-sm font-medium">{host.label}</div>
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {host.username}@{host.address}
                {host.port !== 22 ? `:${host.port}` : ""}
              </span>
              <button
                onClick={copyIp}
                title="Copy IP"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
              </button>
            </div>
            {copied && <div className="mt-1 text-[11px] text-primary">IP copied</div>}
          </div>,
          document.body
        )}

      {menu &&
        createPortal(
          <div
            style={{ position: "fixed", left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            className="z-[9999] w-56 overflow-hidden rounded-lg border border-slate-600 bg-popover py-1 text-popover-foreground shadow-2xl"
          >
            <MenuItem icon={<CopyPlus className="size-4" />} label="Duplicate" onClick={duplicate} />
            <MenuItem icon={<ExternalLink className="size-4" />} label="Duplicate in a new window" onClick={duplicateWindow} />
            <div className="my-1 h-px bg-border" />
            <MenuItem icon={<X className="size-4" />} label="Close" onClick={() => { setMenu(null); props.api.close(); }} />
          </div>,
          document.body
        )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}
