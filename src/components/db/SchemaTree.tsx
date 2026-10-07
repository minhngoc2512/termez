import { useEffect, useRef, useState } from "react";
import { ChevronRight, Database, Layers, Table2, Eye, Columns3, Loader2, RefreshCw, KeyRound, Info, FileJson, Plus, Search, X } from "lucide-react";
import * as dbPool from "../../lib/dbPool";
import type { DbPane } from "../../lib/dbPool";
import type { DbTreeNode } from "../../lib/ipc";
import { CopyableError } from "./CopyableError";
import { cn } from "@/lib/utils";

/** Node chứa bảng: khi lọc thì tự nạp danh sách con để tìm được cả trong database chưa mở. */
const CONTAINERS = new Set(["database", "schema"]);
/** Số database/schema tối đa tự nạp khi lọc. */
const AUTOLOAD_MAX = 50;

const ICONS = { database: Database, schema: Layers, table: Table2, view: Eye, collection: FileJson, column: Columns3, key: KeyRound, info: Info } as const;

export interface TreeMenuAction {
  label: string;
  run: () => void;
  /** Thao tác phá dữ liệu (chữ đỏ). */
  danger?: boolean;
  /** Kẻ ngăn cách phía trên mục này. */
  separator?: boolean;
}

interface Props {
  panelId: string;
  pane: DbPane;
  /** Double-click bảng/view, collection MongoDB hoặc key Redis. */
  onOpenNode: (node: DbTreeNode, path: string[]) => void;
  /** Menu chuột phải cho một node. */
  menuFor: (node: DbTreeNode, path: string[]) => TreeMenuAction[];
  /** Nút "+" ở đầu cây (tạo database); bỏ trống = ẩn. */
  onNewDatabase?: () => void;
  newDatabaseLabel?: string;
}

export function SchemaTree({ panelId, pane, onOpenNode, menuFor, onNewDatabase, newDatabaseLabel }: Props) {
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

  const scoped = dbPool.scopedDatabase(pane);
  const configured = pane.session?.configured_database ?? null;
  const q = pane.filter.trim().toLowerCase();
  const filterInput = useRef<HTMLInputElement>(null);
  // Danh sách con đã tự nạp khi lọc: key → đã xong chưa.
  const requested = useRef(new Map<string, boolean>());
  const [, setLoadedTick] = useState(0);

  const matches = (name: string) => name.toLowerCase().includes(q);
  const rootNodes = (): DbTreeNode[] | undefined => {
    const nodes = pane.children[""];
    if (!scoped || !nodes) return nodes;
    const hit = nodes.filter((n) => n.name === scoped);
    return hit.length ? hit : [{ name: scoped, kind: "database", detail: null, leaf: false }];
  };
  /** Có node con/cháu (đã nạp, không tính cột) khớp ô lọc. */
  const hasMatch = (path: string[]): boolean =>
    (pane.children[dbPool.pathKey(path)] ?? []).some(
      (n) => n.kind !== "column" && n.kind !== "info" && (matches(n.name) || (!n.leaf && hasMatch([...path, n.name])))
    );

  // Đang lọc → nạp danh sách con của mọi database / schema chưa mở (có giới hạn).
  useEffect(() => {
    // Bỏ lọc / cây vừa Refresh (mất gốc) → quên các lần nạp trước.
    if (!q || !pane.children[""]) requested.current.clear();
    if (!q) return;
    const walk = (nodes: DbTreeNode[] | undefined, path: string[]) => {
      for (const n of nodes ?? []) {
        if (!CONTAINERS.has(n.kind)) continue;
        const p = [...path, n.name];
        const k = dbPool.pathKey(p);
        if (pane.children[k]) walk(pane.children[k], p);
        else if (!requested.current.has(k) && requested.current.size < AUTOLOAD_MAX) {
          requested.current.set(k, false);
          void dbPool.loadChildren(panelId, p).finally(() => {
            requested.current.set(k, true);
            setLoadedTick((t) => t + 1);
          });
        }
      }
    };
    walk(rootNodes(), []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pane.children, scoped]);
  const searching = !!q && [...requested.current.values()].some((done) => !done);

  /** Tô phần khớp ô lọc trong tên. */
  function highlight(name: string) {
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    if (i < 0) return name;
    return (
      <>
        {name.slice(0, i)}
        <mark className="rounded-sm bg-amber-400/30 text-inherit">{name.slice(i, i + q.length)}</mark>
        {name.slice(i + q.length)}
      </>
    );
  }

  /** `showAll` = cha đã khớp ô lọc (bảng khớp → hiện mọi cột của nó). */
  function renderLevel(path: string[], depth: number, showAll = false) {
    // Kết nối có chọn database → gốc cây chỉ còn database đó (kể cả khi tài khoản
    // không thấy nó trong danh sách, vẫn hiện để mở được).
    let nodes = path.length === 0 ? rootNodes() : pane.children[dbPool.pathKey(path)];
    if (nodes && q && !showAll) {
      nodes = nodes.filter((n) => matches(n.name) || (!n.leaf && hasMatch([...path, n.name])));
      if (nodes.length === 0) {
        return path.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{searching ? "Searching…" : "No match."}</div>
        ) : null;
      }
    }
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
      const selfMatch = !!q && matches(n.name);
      const descMatch = !!q && !showAll && !n.leaf && hasMatch(p);
      // Đang lọc: tự mở node có con khớp; database/schema khớp tên nhưng có con khớp
      // thì vẫn chỉ hiện con khớp, còn bảng khớp thì hiện đủ cột.
      const open = !!pane.expanded[k] || descMatch;
      const childShowAll = showAll || (selfMatch && !descMatch);
      const Icon = ICONS[n.kind] ?? Table2;
      const openable = n.kind === "table" || n.kind === "view" || n.kind === "collection" || n.kind === "key";
      const current = n.kind === "database" && n.name === pane.database;
      return (
        <div key={k}>
          <div
            onClick={() => !n.leaf && dbPool.toggle(panelId, p)}
            onDoubleClick={() => openable && onOpenNode(n, p)}
            onContextMenu={(e) => {
              e.preventDefault();
              const items = menuFor(n, p);
              // Giữ menu trong cửa sổ khi bấm gần đáy.
              const h = items.length * 32 + 16;
              if (items.length) setMenu({ x: e.clientX, y: Math.max(8, Math.min(e.clientY, window.innerHeight - h)), items });
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
              {q ? highlight(n.name) : n.name}
            </span>
            {/* Đang lọc: ẩn phần phụ (engine, kiểu…) để tên khớp hiện đủ. */}
            {n.detail && (!q || n.kind === "column") && (
              <span className="ml-1 truncate text-[11px] text-muted-foreground">{n.detail}</span>
            )}
          </div>
          {open && !n.leaf && renderLevel(p, depth + 1, childShowAll)}
        </div>
      );
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Schema</span>
        {configured && (
          <button
            onClick={() => dbPool.update(panelId, { showAll: !pane.showAll })}
            title={pane.showAll ? `Show only ${configured} (from the connection settings)` : "Show all databases on the server"}
            className={cn(
              "ml-auto mr-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent",
              pane.showAll ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {pane.showAll ? "All databases" : "Show all"}
          </button>
        )}
        {onNewDatabase && (
          <button
            title={newDatabaseLabel ?? "New database"}
            onClick={onNewDatabase}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", !configured && "ml-auto")}
          >
            <Plus className="size-3.5" />
          </button>
        )}
        <button
          title="Refresh"
          onClick={() => dbPool.refreshTree(panelId)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring/50">
          {searching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            ref={filterInput}
            value={pane.filter}
            onChange={(e) => dbPool.update(panelId, { filter: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && dbPool.update(panelId, { filter: "" })}
            placeholder={
              pane.kind === "mongodb"
                ? "Filter collections…"
                : pane.kind === "redis"
                  ? "Filter keys…"
                  : pane.kind === "bigquery"
                    ? "Filter datasets / tables…"
                    : "Filter databases / tables…"
            }
            className="h-7 w-full min-w-0 bg-transparent text-xs outline-none"
          />
          {pane.filter && (
            <button
              title="Clear (Esc)"
              onClick={() => {
                dbPool.update(panelId, { filter: "" });
                filterInput.current?.focus();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {pane.treeError ? (
          <CopyableError text={pane.treeError} className="px-3 py-2" />
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
            <div key={it.label}>
              {it.separator && <div className="my-1 h-px bg-border" />}
              <button
                onClick={() => {
                  setMenu(null);
                  it.run();
                }}
                className={cn("block w-full px-3 py-1.5 text-left hover:bg-accent", it.danger && "text-destructive")}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
