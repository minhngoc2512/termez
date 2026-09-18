import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check, CopyPlus, Columns2, ExternalLink } from "lucide-react";
import { useStore } from "../store";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/utils";

export type TaskItem = { id: string; name: string; isWs: boolean; hostId?: string };

/**
 * Một mục trên thanh TASK (ngoài dockview). Nếu là task của một host lẻ:
 * hover hiện popup IP + nút copy; chuột phải mở menu Duplicate / Split.
 */
export function TaskTab({
  task,
  active,
  onSwitch,
  onClose,
  onDuplicate,
  onSplit,
  onDuplicateWindow,
}: {
  task: TaskItem;
  active: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onSplit: (id: string) => void;
  onDuplicateWindow: (hostId: string, title: string) => void;
}) {
  const hosts = useStore((s) => s.hosts);
  const host = task.hostId ? hosts.find((h) => h.id === task.hostId) : undefined;

  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);

  function openPopup() {
    if (timer.current) window.clearTimeout(timer.current);
    if (!host) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left, y: r.bottom + 4 });
  }
  function scheduleClose() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPos(null), 160);
  }

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  function onContextMenu(e: React.MouseEvent) {
    if (!host) return; // chỉ task của host mới có menu
    e.preventDefault();
    e.stopPropagation();
    setPos(null);
    setMenu({ x: e.clientX, y: e.clientY });
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
      ref={ref}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("termez/task", task.id); e.dataTransfer.effectAllowed = "move"; }}
      onClick={() => onSwitch(task.id)}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(task.id); } }}
      onMouseEnter={openPopup}
      onMouseLeave={scheduleClose}
      onContextMenu={onContextMenu}
      title={task.name}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1 text-[13px] transition-colors",
        active ? "border-border bg-card text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {task.isWs
        ? <Columns2 className="size-3.5 shrink-0 text-primary" />
        : <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-primary" : "bg-muted-foreground/40")} />}
      <span className="max-w-[170px] truncate">{task.name}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(task.id); }}
        title="Close"
        className="flex size-4 items-center justify-center rounded text-muted-foreground/70 hover:bg-border hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>

      {pos && host &&
        createPortal(
          <div
            style={{ position: "fixed", left: pos.x, top: pos.y }}
            onMouseEnter={openPopup}
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
            <MenuItem icon={<CopyPlus className="size-4" />} label="Duplicate" onClick={() => { setMenu(null); onDuplicate(task.id); }} />
            <MenuItem icon={<Columns2 className="size-4" />} label="Split" onClick={() => { setMenu(null); onSplit(task.id); }} />
            <MenuItem icon={<ExternalLink className="size-4" />} label="Duplicate in a new window" onClick={() => { setMenu(null); if (task.hostId) onDuplicateWindow(task.hostId, task.name); }} />
            <div className="my-1 h-px bg-border" />
            <MenuItem icon={<X className="size-4" />} label="Close" onClick={() => { setMenu(null); onClose(task.id); }} />
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
