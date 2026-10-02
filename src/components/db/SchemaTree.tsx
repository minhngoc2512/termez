import { useEffect, useState } from "react";
import { ChevronRight, Database, Layers, Table2, Eye, Columns3, Loader2, RefreshCw, KeyRound, Info } from "lucide-react";
import * as dbPool from "../../lib/dbPool";
import type { DbPane } from "../../lib/dbPool";
import type { DbTreeNode } from "../../lib/ipc";
import { cn } from "@/lib/utils";

const ICONS = { database: Database, schema: Layers, table: Table2, view: Eye, column: Columns3, key: KeyRound, info: Info } as const;

export interface TreeMenuAction {
  label: string;
  run: () => void;
}

interface Props {
  panelId: string;
  pane: DbPane;
  /** Double-click bảng/view hoặc key Redis. */
  onOpenNode: (node: DbTreeNode, path: string[]) => void;
  /** Menu chuột phải cho một node. */
  menuFor: (node: DbTreeNode, path: string[]) => TreeMenuAction[];
}

export function SchemaTree({ panelId, pane, onOpenNode, menuFor }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: TreeMenuAction[] } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function renderLevel(path: string[], depth: number) {
    const nodes = pane.children[dbPool.pathKey(path)];
    if (!nodes) {
      return (
        <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 14 }}>
          <Loader2 className="size-3 animate-spin" /> Loading…
        </div>
      );
    }
    if (nodes.length === 0) {
      return (
        <div className="py-1 text-xs text-muted-foreground/70" style={{ paddingLeft: 22 + depth * 14 }}>
          (empty)
        </div>
      );
    }
    return nodes.map((n) => {
      const p = [...path, n.name];
      const k = dbPool.pathKey(p);
      const open = !!pane.expanded[k];
      const Icon = ICONS[n.kind] ?? Table2;
      const openable = n.kind === "table" || n.kind === "view" || n.kind === "key";
      const current = n.kind === "database" && n.name === pane.database;
      return (
        <div key={k}>
          <div
            onClick={() => !n.leaf && dbPool.toggle(panelId, p)}
            onDoubleClick={() => openable && onOpenNode(n, p)}
            onContextMenu={(e) => {
              e.preventDefault();
              const items = menuFor(n, p);
              if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
            }}
            className="group flex cursor-pointer select-none items-center gap-1 rounded py-[3px] pr-2 text-[13px] hover:bg-accent"
            style={{ paddingLeft: 6 + depth * 14 }}
            title={n.detail ? `${n.name} · ${n.detail}` : n.name}
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", n.leaf && "invisible")}
            />
            <Icon className={cn("size-3.5 shrink-0", n.kind === "column" || n.kind === "info" ? "text-muted-foreground" : "text-primary")} />
            <span className={cn("truncate", current && "font-semibold text-primary", n.kind === "info" && "text-xs italic text-muted-foreground")}>
              {n.name}
            </span>
            {n.detail && <span className="ml-1 truncate text-[11px] text-muted-foreground">{n.detail}</span>}
          </div>
          {open && !n.leaf && renderLevel(p, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Schema</span>
        <button
          title="Refresh"
          onClick={() => dbPool.refreshTree(panelId)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {pane.treeError ? (
          <div className="px-3 py-2 text-xs text-destructive">{pane.treeError}</div>
        ) : pane.status === "ready" ? (
          renderLevel([], 0)
        ) : null}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.items.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-accent"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
