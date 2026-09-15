import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IDockviewPanelHeaderProps } from "dockview-react";
import { X, Copy, Check } from "lucide-react";
import { useStore } from "../store";

/**
 * Tab tùy chỉnh cho dockview: hiện tên panel; hover vào tab (nếu là host)
 * bật popup thông tin IP + nút copy IP.
 */
export function PanelTab(props: IDockviewPanelHeaderProps<{ hostId?: string }>) {
  const hosts = useStore((s) => s.hosts);
  const hostId = props.params?.hostId;
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;

  const tabRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);

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

  function copyIp(e: React.MouseEvent) {
    e.stopPropagation();
    if (!host) return;
    navigator.clipboard
      .writeText(host.address)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }

  return (
    <div
      ref={tabRef}
      className="flex items-center gap-1.5 px-2"
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
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
    </div>
  );
}
