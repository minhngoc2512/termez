import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy } from "lucide-react";
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

/** Lưới kết quả ảo hoá (chỉ vẽ các dòng đang thấy) — mượt với hàng chục nghìn dòng. */
export function ResultGrid({ rs }: { rs: DbResultSet }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [viewer, setViewer] = useState<{ col: string; value: string } | null>(null);

  // Độ rộng cột theo nội dung (lấy mẫu 200 dòng đầu) và cột nào là số (căn phải).
  const { widths, numeric } = useMemo(() => {
    const sample = rs.rows.slice(0, 200);
    const widths = rs.columns.map((col, i) => {
      let len = Math.max(col.name.length, (col.type_name ?? "").length * 0.8);
      for (const r of sample) len = Math.max(len, Math.min((r[i] ?? "NULL").length, 60));
      return Math.round(Math.min(Math.max(len * CHAR_W + 24, 64), 460));
    });
    const numeric = rs.columns.map((col, i) => {
      if (col.type_name) return isNumericType(col.type_name);
      const vals = sample.map((r) => r[i]).filter((v): v is string => v !== null);
      return vals.length > 0 && vals.every((v) => /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v));
    });
    return { widths, numeric };
  }, [rs]);

  const total = NUM_W + widths.reduce((a, b) => a + b, 0);
  const virt = useVirtualizer({
    count: rs.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 24,
  });

  function onKeyDown(e: React.KeyboardEvent) {
    if (!sel) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyText(rs.rows[sel.r]?.[sel.c] ?? "").catch(() => {});
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
    const r = Math.min(Math.max(sel.r + d[0], 0), rs.rows.length - 1);
    const c = Math.min(Math.max(sel.c + d[1], 0), rs.columns.length - 1);
    setSel({ r, c });
    virt.scrollToIndex(r);
  }

  return (
    <>
      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="h-full overflow-auto outline-none"
        style={{ fontFamily: MONO, fontSize: 12 }}
      >
        <div style={{ width: total, minWidth: "100%" }}>
          {/* Header dính trên cùng */}
          <div className="sticky top-0 z-10 flex border-b border-border bg-sidebar" style={{ height: ROW_H + 6 }}>
            <div className="shrink-0 border-r border-border" style={{ width: NUM_W }} />
            {rs.columns.map((c, i) => (
              <div
                key={i}
                className="flex shrink-0 flex-col justify-center overflow-hidden border-r border-border px-2"
                style={{ width: widths[i] }}
                title={c.type_name ? `${c.name} · ${c.type_name}` : c.name}
              >
                <span className="truncate font-semibold text-foreground">{c.name}</span>
              </div>
            ))}
          </div>
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vr) => {
              const row = rs.rows[vr.index];
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
        </div>
      </div>

      <Dialog open={viewer !== null} onOpenChange={(o) => !o && setViewer(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{viewer?.col}</DialogTitle>
          </DialogHeader>
          <pre
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 text-xs"
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
    </>
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
