import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, TriangleAlert, RotateCw, Lock, OctagonX, HardDrive } from "lucide-react";
import { api, DbKind, DbMonitorSnapshot, DbSessionInfo } from "../../lib/ipc";
import { confirmDialog, alertDialog } from "../../lib/dialogs";
import { Card, fmtBytes, fmtUptime } from "../MonitorView";
import { DbIcon } from "./DbIcon";
import { SPECS, Vals, fmtNum } from "./monitorSpecs";
import { CopyableError } from "./CopyableError";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const KEEP = 90; // số mẫu giữ lại cho biểu đồ
const INTERVALS = [1, 2, 5, 10];
const BREAKDOWN_EVERY_MS = 30_000; // dung lượng/keys: đo thưa hơn (truy vấn nặng hơn)

/**
 * Monitor một kết nối database: phiên riêng (kể cả qua SSH tunnel), đo định kỳ,
 * biểu đồ theo thời gian + bảng query/client đang chạy (kill được, trừ read-only).
 */
export function DbMonitorView({ connId, kind, name }: { connId: string; kind: DbKind; name: string }) {
  const spec = SPECS[kind];
  const [session, setSession] = useState<DbSessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<DbMonitorSnapshot | null>(null);
  const [derived, setDerived] = useState<Vals>({});
  const [paused, setPaused] = useState(false);
  const [interval, setIntervalSec] = useState(2);
  const [breakdown, setBreakdown] = useState<[string, number][] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const history = useRef<Record<string, number[]>>({});
  const prev = useRef<{ vals: Vals; at: number } | null>(null);
  const lastBreakdown = useRef(0);
  const pollNow = useRef<() => void>(() => {});

  // Mở phiên riêng cho Monitor; đóng khi rời tab.
  useEffect(() => {
    let closed = false;
    let sid: string | null = null;
    setError(null);
    setSession(null);
    prev.current = null; // phiên mới → tính tốc độ lại từ đầu
    api
      .dbOpen(connId)
      .then((s) => {
        if (closed) return void api.dbClose(s.session_id).catch(() => {});
        sid = s.session_id;
        setSession(s);
      })
      .catch((e) => !closed && setError(String(e)));
    return () => {
      closed = true;
      if (sid) api.dbClose(sid).catch(() => {});
    };
  }, [connId, attempt]);

  // Vòng đo (setTimeout nối tiếp — không chồng lệnh khi server chậm).
  useEffect(() => {
    if (!session || paused) return;
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      window.clearTimeout(timer);
      const wantBreakdown = Date.now() - lastBreakdown.current > BREAKDOWN_EVERY_MS;
      try {
        const s = await api.dbMonitor(session.session_id, wantBreakdown);
        if (stop) return;
        const now = Date.now();
        const dt = prev.current ? Math.max(0.2, (now - prev.current.at) / 1000) : 1;
        const d = spec.derive(prev.current?.vals ?? null, s.values, dt);
        prev.current = { vals: s.values, at: now };
        for (const [k, v] of Object.entries(d)) {
          const arr = (history.current[k] ??= []);
          arr.push(Number.isFinite(v) ? v : arr[arr.length - 1] ?? 0);
          if (arr.length > KEEP) arr.shift();
        }
        if (s.breakdown) {
          setBreakdown(s.breakdown);
          lastBreakdown.current = now;
        }
        setDerived(d);
        setSnap(s);
        setError(null);
      } catch (e) {
        if (!stop) setError(String(e));
        return; // dừng đo; nút Retry mở lại phiên
      }
      if (!stop) timer = window.setTimeout(poll, interval * 1000);
    };
    pollNow.current = poll;
    void poll();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [session, paused, interval, spec]);

  async function kill(target: string, label: string) {
    if (!session) return;
    if (!(await confirmDialog({ title: "Kill", message: `Cancel ${label} ${target}?`, confirmText: "Kill", danger: true }))) return;
    try {
      await api.dbMonitorKill(session.session_id, target);
      pollNow.current();
    } catch (e) {
      alertDialog({ title: "Kill failed", message: String(e) });
    }
  }

  if (!spec) {
    return <div className="p-6 text-sm text-muted-foreground">Monitoring isn't available for this database type yet.</div>;
  }
  if (error && !snap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <TriangleAlert className="size-8 text-destructive" />
        <CopyableError text={error} className="w-full max-w-lg text-left" />
        <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
          <RotateCw className="size-4" /> Retry
        </Button>
      </div>
    );
  }
  if (!session || !snap) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting & collecting metrics…
      </div>
    );
  }

  const uptime = spec.uptime(snap.values);
  const readOnly = session.read_only;
  const maxBreak = Math.max(1, ...(breakdown ?? []).map(([, v]) => v));

  return (
    <div className="h-full overflow-y-auto bg-background">
      {/* Thanh trạng thái */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <DbIcon kind={kind} className="size-4" />
        <span className="font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {session.server_version}
          {uptime !== undefined && ` · up ${fmtUptime(uptime)}`}
        </span>
        {readOnly && (
          <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-500">
            <Lock className="size-3" /> Read-only — kill disabled
          </span>
        )}
        <span className={cn("ml-auto flex items-center gap-1.5 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          <span className={cn("size-2 rounded-full", error ? "bg-destructive" : paused ? "bg-muted-foreground" : "animate-pulse bg-primary")} />
          {error ? "Error" : paused ? "Paused" : "Live"}
        </span>
        <Select value={String(interval)} onValueChange={(v) => setIntervalSec(Number(v))}>
          <SelectTrigger size="sm" className="h-7 text-xs" title="Refresh interval">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVALS.map((s) => (
              <SelectItem key={s} value={String(s)}>
                every {s}s
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error ? (
          <Button size="sm" variant="outline" className="h-7" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCw className="size-3.5" /> Retry
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>
        )}
      </div>
      {error && <CopyableError text={error} className="mx-4 mt-3" />}

      <div className="space-y-4 p-4">
        {/* Biểu đồ */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {spec.cards.map((c) => {
            const max = c.max ?? Math.max(1, ...c.series.flatMap((s) => history.current[s.key] ?? []));
            return (
              <Card key={c.title} title={c.title} icon={c.icon} value={<span className="text-xl">{c.value(derived)}</span>} sub={c.sub?.(derived)}>
                <MultiChart series={c.series.map((s) => ({ data: history.current[s.key] ?? [], color: s.color }))} max={max} />
                {c.series.length > 1 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    {c.series.map((s) => (
                      <span key={s.key} className="flex items-center gap-1">
                        <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} /> {s.label}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        {/* Bảng hoạt động: query đang chạy / client / slow log */}
        {snap.tables.map((t) => (
          <div key={t.title} className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t.title} <span className="font-normal normal-case">({t.rows.length})</span>
            </div>
            {t.rows.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">Nothing right now.</p>
            ) : (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                    <tr>
                      {t.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-3 py-1.5 font-medium">
                          {c}
                        </th>
                      ))}
                      {t.killable && <th className="w-16" />}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {t.rows.map((r, i) => (
                      <tr key={r.id ?? i} className="border-t border-border/60 hover:bg-accent/40">
                        {r.cells.map((c, ci) => (
                          <td
                            key={ci}
                            className={cn("max-w-[32rem] px-3 py-1.5", ci === r.cells.length - 1 ? "selectable truncate" : "whitespace-nowrap")}
                            title={c ?? undefined}
                          >
                            {c ?? <span className="text-muted-foreground/60">—</span>}
                          </td>
                        ))}
                        {t.killable && (
                          <td className="px-2 py-1 text-right">
                            {r.id && (
                              <button
                                disabled={readOnly}
                                onClick={() => kill(r.id!, t.title === "Clients" ? "client" : "query")}
                                title={readOnly ? "Read-only connection" : "Cancel this query / disconnect this client"}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <OctagonX className="size-3.5" /> Kill
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}

        {/* Phân bổ: dung lượng / số key theo database */}
        {breakdown && breakdown.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <HardDrive className="size-4" /> {spec.breakdownTitle}
            </div>
            <div className="space-y-1.5">
              {breakdown.map(([label, v]) => (
                <div key={label} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate font-mono text-xs" title={label}>
                    {label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${(v / maxBreak) * 100}%` }} />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                    {spec.breakdownUnit === "bytes" ? fmtBytes(v) : `${fmtNum(v)} keys`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nhiều đường trên cùng một trục (cùng thang `max`). */
function MultiChart({ series, max }: { series: { data: number[]; color: string }[]; max: number }) {
  const w = 100;
  const h = 32;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-16 w-full">
      {series.map(({ data, color }, si) => {
        const n = data.length;
        if (n === 0) return null;
        const x = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
        const y = (v: number) => h - Math.min(1, v / (max || 1)) * h;
        const line = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        return (
          <g key={si}>
            {si === 0 && <polygon points={`${x(0).toFixed(1)},${h} ${line} ${x(n - 1).toFixed(1)},${h}`} fill={color} opacity="0.12" />}
            <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}
