import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, CopyPlus, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Task {
  id: string;
  title: string;
  hostId?: string;
}

interface Props {
  tasks: Task[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDuplicateWindow: (id: string) => void;
}

/**
 * Thanh danh sách phiên/tab — render CỐ ĐỊNH ở trên (ngoài dockview) nên không
 * bao giờ bị cuộn theo nội dung terminal. Chuột phải để Duplicate; chuột giữa
 * hoặc nút X để đóng.
 */
export function TaskBar({ tasks, activeId, onSelect, onClose, onDuplicate, onDuplicateWindow }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; hostId?: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  if (tasks.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border bg-sidebar px-2 py-1.5">
      {tasks.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, id: t.id, hostId: t.hostId }); }}
            title={t.title}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1 text-[13px] transition-colors",
              active
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-primary" : "bg-muted-foreground/40")} />
            <span className="max-w-[170px] truncate">{t.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              title="Close"
              className="flex size-4 items-center justify-center rounded text-muted-foreground/70 hover:bg-border hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}

      {menu &&
        createPortal(
          <div
            style={{ position: "fixed", left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            className="z-[9999] w-56 overflow-hidden rounded-lg border border-slate-600 bg-popover py-1 text-popover-foreground shadow-2xl"
          >
            {menu.hostId && (
              <>
                <Item icon={<CopyPlus className="size-4" />} label="Duplicate" onClick={() => { onDuplicate(menu.id); setMenu(null); }} />
                <Item icon={<ExternalLink className="size-4" />} label="Duplicate in a new window" onClick={() => { onDuplicateWindow(menu.id); setMenu(null); }} />
                <div className="my-1 h-px bg-border" />
              </>
            )}
            <Item icon={<X className="size-4" />} label="Close" onClick={() => { onClose(menu.id); setMenu(null); }} />
          </div>,
          document.body
        )}
    </div>
  );
}

function Item({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
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
