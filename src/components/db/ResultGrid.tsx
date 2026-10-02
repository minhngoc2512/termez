import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, ArrowUp, ArrowDown, Filter, X } from "lucide-react";
import type { DbResultSet } from "../../lib/ipc";
import { isNumericType } from "../../lib/sql";
import { copyText } from "../../lib/clipboard";
import { MONO } from "./SqlEditor";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const ROW_H = 26;
const NUM_W = 52; // cột số thứ tự
const CHAR_W = 7.4;

type Sort = { col: number; dir: "asc" | "desc" } | null;

/**
 * Điều kiện lọc của một cột:
 *  text → chứa (không phân biệt hoa thường) · `=x` bằng · `!x` không chứa · `!=x` khác
 *  `>n` `>=n` `<n` `<=n` so sánh số · `null` / `!null` là / không là NULL.
 */
function matcher(raw: string, numeric: boolean): (v: string | null) => boolean {
  const f = raw.trim();
  const lower = f.toLowerCase();
  if (lower === "null") return (v) => v === null;
  if (lower === "!null") return (v) => v !== null;
  const cmp = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(f);
  if (cmp && numeric) {
    const n = Number(cmp[2]);
    const op = cmp[1];
    return (v) => {
      if (v === null) return false;
      const x = Number(v);
      return op === ">" ? x > n : op === ">=" ? x >= n : op === "<" ? x < n : x <= n;
    };
  }
  if (f.startsWith("!=")) {
    const t = f.slice(2).trim().toLowerCase();
    return (v) => (v ?? "").toLowerCase() !== t;
  }
  if (f.startsWith("=")) {
    const t = f.slice(1).trim().toLowerCase();
    return (v) => (v ?? "").toLowerCase() === t;
  }
  if (f.startsWith("!")) {
    const t = f.slice(1).toLowerCase();
    return (v) => !(v ?? "").toLowerCase().includes(t);
  }
  return (v) => v !== null && v.toLowerCase().includes(lower);
}

/** Lưới kết quả ảo hoá (chỉ vẽ các dòng đang thấy) — mượt với hàng chục nghìn dòng. */
export function ResultGrid({ rs }: { rs: DbResultSet }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [viewer, setViewer] = useState<{ col: string; value: string } | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [filterOpen, setFilterOpen] = useState<number | null>(null);

  // Độ rộng cột theo nội dung (lấy mẫu 200 dòng đầu) và cột nào là số (căn phải).
  const { widths, numeric } = useMemo(() => {
    const sample = rs.rows.slice(0, 200);
    const widths = rs.columns.map((col, i) => {
      let len = Math.max(col.name.length + 5, (col.type_name ?? "").length * 0.8); // +chỗ cho mũi tên sort + phễu
      for (const r of sample) len = Math.max(len, Math.min((r[i] ?? "NULL").length, 60));
      return Math.round(Math.min(Math.max(len * CHAR_W + 24, 72), 460));
    });
    const numeric = rs.columns.map((col, i) => {
      if (col.type_name) return isNumericType(col.type_name);
      const vals = sample.map((r) => r[i]).filter((v): v is string => v !== null);
      return vals.length > 0 && vals.every((v) => /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v));
    });
    return { widths, numeric };
  }, [rs]);

  // Chỉ số các dòng đang hiện, sau khi lọc + sắp xếp (trên các dòng đã tải về).
  const view = useMemo(() => {
    const active = Object.entries(filters)
      .filter(([, f]) => f.trim() !== "")
      .map(([c, f]) => [Number(c), matcher(f, numeric[Number(c)])] as const);
    let idx = rs.rows.map((_, i) => i);
    if (active.length) idx = idx.filter((i) => active.every(([c, m]) => m(rs.rows[i][c])));
    if (sort) {
      const { col, dir } = sort;
      const num = numeric[col];
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      idx.sort((a, b) => {
        const x = rs.rows[a][col];
        const y = rs.rows[b][col];
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // NULL luôn cuối
        const r = num ? Number(x) - Number(y) : coll.compare(x, y);
        return dir === "asc" ? r : -r;
      });
    }
    return idx;
  }, [rs, filters, sort, numeric]);

  const filtered = view.length !== rs.rows.length;
  const total = NUM_W + widths.reduce((a, b) => a + b, 0);
  const virt = useVirtualizer({
    count: view.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 24,
  });

  // Đổi lọc/sắp xếp → bỏ chọn ô (vị trí cũ không còn đúng dòng).
  useEffect(() => setSel(null), [filters, sort]);

  function cycleSort(col: number) {
    setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!sel) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyText(rs.rows[view[sel.r]]?.[sel.c] ?? "").catch(() => {});
      return;
    }
    const move: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const d = move[e.key];
    if (!d) return;
    e.preventDefault();
    const r = Math.min(Math.max(sel.r + d[0], 0), view.length - 1);
    const c = Math.min(Math.max(sel.c + d[1], 0), rs.columns.length - 1);
    setSel({ r, c });
    virt.scrollToIndex(r);
  }

  return (
    <div className="flex h-full flex-col">
      {(filtered || sort) && (
        <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-3 py-1 text-xs text-muted-foreground">
          {filtered && (
            <span>
              Showing <b className="text-foreground">{view.length.toLocaleString()}</b> of {rs.rows.length.toLocaleString()} rows
            </span>
          )}
          {sort && (
            <span>
              Sorted by <b className="text-foreground">{rs.columns[sort.col].name}</b> {sort.dir === "asc" ? "↑" : "↓"}
            </span>
          )}
          <span className="text-muted-foreground/70">(on the loaded rows)</span>
          <button
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={() => {
              setFilters({});
              setSort(null);
              setFilterOpen(null);
            }}
          >
            <X className="size-3" /> Clear
          </button>
        </div>
      )}
      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
        style={{ fontFamily: MONO, fontSize: 12 }}
      >
        <div style={{ width: total, minWidth: "100%" }}>
          {/* Header dính trên cùng: bấm tên để sắp xếp, phễu để lọc */}
          <div className="sticky top-0 z-10 flex border-b border-border bg-sidebar" style={{ height: ROW_H + 6 }}>
            <div className="shrink-0 border-r border-border" style={{ width: NUM_W }} />
            {rs.columns.map((c, i) => {
              const f = filters[i]?.trim();
              return (
                <div
                  key={i}
                  className="group/col relative flex shrink-0 items-center border-r border-border"
                  style={{ width: widths[i] }}
                >
                  <button
                    onClick={() => cycleSort(i)}
                    className={cn(
                      "flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left hover:bg-accent/60",
                      numeric[i] && "justify-end"
                    )}
                    title={`${c.type_name ? `${c.name} · ${c.type_name}` : c.name}\nClick to sort`}
                  >
                    <span className="truncate font-semibold text-foreground">{c.name}</span>
                    {sort?.col === i &&
                      (sort.dir === "asc" ? (
                        <ArrowUp className="size-3 shrink-0 text-primary" />
                      ) : (
                        <ArrowDown className="size-3 shrink-0 text-primary" />
                      ))}
                  </button>
                  <button
                    data-col-filter
                    title={f ? `Filter: ${f}` : "Filter this column"}
                    onClick={() => setFilterOpen(filterOpen === i ? null : i)}
                    className={cn(
                      "mr-1 shrink-0 rounded p-0.5 hover:bg-accent",
                      f ? "text-primary" : "text-muted-foreground opacity-0 group-hover/col:opacity-100",
                      filterOpen === i && "opacity-100"
                    )}
                  >
                    <Filter className={cn("size-3", f && "fill-current")} />
                  </button>
                  {filterOpen === i && (
                    <ColumnFilter
                      value={filters[i] ?? ""}
                      numeric={numeric[i]}
                      onChange={(v) => setFilters((all) => ({ ...all, [i]: v }))}
                      onClose={() => setFilterOpen(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vr) => {
              const row = rs.rows[view[vr.index]];
              return (
                <div
                  key={vr.index}
                  className={cn("absolute left-0 flex border-b border-border/60", vr.index % 2 === 1 && "bg-card/40")}
                  style={{ top: 0, height: ROW_H, transform: `translateY(${vr.start}px)`, width: total, minWidth: "100%" }}
                >
                  <div
                    className="shrink-0 border-r border-border px-2 text-right text-muted-foreground"
                    style={{ width: NUM_W, lineHeight: `${ROW_H}px` }}
                  >
                    {vr.index + 1}
                  </div>
                  {row.map((v, ci) => (
                    <div
                      key={ci}
                      onMouseDown={() => setSel({ r: vr.index, c: ci })}
                      onDoubleClick={() => setViewer({ col: rs.columns[ci].name, value: v ?? "NULL" })}
                      className={cn(
                        "shrink-0 cursor-default truncate border-r border-border/60 px-2",
                        numeric[ci] && "text-right",
                        sel?.r === vr.index && sel.c === ci && "bg-primary/20 outline outline-1 -outline-offset-1 outline-primary"
                      )}
                      style={{ width: widths[ci], lineHeight: `${ROW_H}px` }}
                      title={v && v.length > 40 ? v.slice(0, 500) : undefined}
                    >
                      {v === null ? <span className="italic text-muted-foreground/70">NULL</span> : v}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {view.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground" style={{ fontFamily: "var(--font-sans)" }}>
              No rows match the filters.
            </div>
          )}
        </div>
      </div>

      <Dialog open={viewer !== null} onOpenChange={(o) => !o && setViewer(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{viewer?.col}</DialogTitle>
          </DialogHeader>
          <pre
            className="selectable max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 text-xs"
            style={{ fontFamily: MONO }}
          >
            {viewer && formatValue(viewer.value)}
          </pre>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => viewer && copyText(viewer.value).catch(() => {})}>
              <Copy className="size-4" /> Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Ô lọc nổi dưới tên cột. Enter/Esc để đóng; xoá trắng = bỏ lọc cột này. */
function ColumnFilter({
  value,
  numeric,
  onChange,
  onClose,
}: {
  value: string;
  numeric: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Bấm lại nút phễu thì để nút đó tự bật/tắt.
      if (!box.current?.contains(t) && !t.closest?.("[data-col-filter]")) onClose();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);
  return (
    <div
      ref={box}
      className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-popover p-2 shadow-lg"
      style={{ fontFamily: "var(--font-sans)" }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2">
        <Filter className="size-3.5 text-muted-foreground" />
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && onClose()}
          placeholder={numeric ? "contains, =x, >10, <=5, null…" : "contains, =exact, !not, null…"}
          className="w-full bg-transparent py-1 text-xs outline-none"
        />
        {value && (
          <button title="Clear filter" onClick={() => onChange("")} className="text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
        Text: contains · <code>=x</code> equals · <code>!x</code> doesn't contain · <code>null</code> / <code>!null</code>
        {numeric && (
          <>
            {" "}· Numbers: <code>&gt;10</code> <code>&gt;=10</code> <code>&lt;5</code> <code>&lt;=5</code>
          </>
        )}
      </div>
    </div>
  );
}

/** JSON → in đẹp; còn lại giữ nguyên. */
function formatValue(v: string): string {
  const s = v.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      /* không phải JSON */
    }
  }
  return v;
}
