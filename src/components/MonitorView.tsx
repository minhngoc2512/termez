import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp, Activity, Loader2, TriangleAlert } from "lucide-react";
import { api, Metrics } from "../lib/ipc";
import { cn } from "@/lib/utils";

const KEEP = 60; // số mẫu giữ lại (~2 phút ở 2s/mẫu)

function fmtBytes(b: number): string {
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function MonitorView({ hostId }: { hostId: string }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cpu = useRef<number[]>([]);
  const mem = useRef<number[]>([]);
  const rx = useRef<number[]>([]);
  const tx = useRef<number[]>([]);
  const [, tick] = useState(0);

  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    api.monitorStart(hostId).catch((e) => !disposed && setError(String(e)));
    listen<{ id: string; metrics?: Metrics; error?: string }>("monitor:data", (e) => {
      if (disposed || e.payload.id !== hostId) return;
      if (e.payload.error) { setError(e.payload.error); return; }
      const met = e.payload.metrics;
      if (!met) return;
      setError(null);
      setM(met);
      const push = (arr: React.MutableRefObject<number[]>, v: number) => {
        arr.current.push(v);
        if (arr.current.length > KEEP) arr.current.shift();
      };
      push(cpu, met.cpu_percent);
      push(mem, met.mem_total_kb > 0 ? (met.mem_used_kb / met.mem_total_kb) * 100 : 0);
      push(rx, met.net_rx_bps);
      push(tx, met.net_tx_bps);
      tick((t) => t + 1);
    }).then((f) => { if (disposed) f(); else un = f; });

    return () => {
      disposed = true;
      un?.();
      api.monitorStop(hostId).catch(() => {});
    };
  }, [hostId]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center text-muted-foreground">
        <TriangleAlert className="size-10 text-destructive" />
        <p className="max-w-md text-sm">{error}</p>
      </div>
    );
  }
  if (!m) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting & collecting metrics…
      </div>
    );
  }

  const netMax = Math.max(1, ...rx.current, ...tx.current);

  return (
    <div className="h-full overflow-y-auto bg-background p-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="CPU" icon={Cpu} value={`${m.cpu_percent.toFixed(0)}%`} sub={`load ${m.load1.toFixed(2)}`}>
          <Chart data={cpu.current} max={100} color="#22c55e" />
        </Card>
        <Card title="Memory" icon={MemoryStick} value={`${((m.mem_used_kb / (m.mem_total_kb || 1)) * 100).toFixed(0)}%`}
          sub={`${fmtBytes(m.mem_used_kb * 1024)} / ${fmtBytes(m.mem_total_kb * 1024)}`}>
          <Chart data={mem.current} max={100} color="#f59e0b" />
        </Card>
        <Card title="Network" icon={Activity}
          value={<span className="flex items-center gap-3 text-base">
            <span className="flex items-center gap-1 text-cyan-400"><ArrowDown className="size-4" />{fmtBytes(m.net_rx_bps)}/s</span>
            <span className="flex items-center gap-1 text-fuchsia-400"><ArrowUp className="size-4" />{fmtBytes(m.net_tx_bps)}/s</span>
          </span>}
          sub={`uptime ${fmtUptime(m.uptime_secs)}`}>
          <div className="relative">
            <Chart data={rx.current} max={netMax} color="#06b6d4" />
            <div className="absolute inset-0"><Chart data={tx.current} max={netMax} color="#d946ef" /></div>
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <HardDrive className="size-4" /> Disks
        </div>
        <div className="space-y-2">
          {m.disks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No disks reported.</p>
          ) : m.disks.map((d) => {
            const pct = d.total_kb > 0 ? (d.used_kb / d.total_kb) * 100 : 0;
            return (
              <div key={d.mount} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="truncate font-mono">{d.mount}</span>
                  <span className="text-xs text-muted-foreground">
                    {fmtBytes(d.used_kb * 1024)} / {fmtBytes(d.total_kb * 1024)} · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full", pct > 90 ? "bg-destructive" : pct > 75 ? "bg-orange-500" : "bg-primary")} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Card({ title, icon: Icon, value, sub, children }: {
  title: string; icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode; sub?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-4" /> {title}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Chart({ data, max, color }: { data: number[]; max: number; color: string }) {
  const w = 100, h = 32, n = data.length;
  if (n === 0) return <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" />;
  const x = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => h - Math.min(1, v / (max || 1)) * h;
  const line = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-16 w-full">
      <polygon points={`${x(0).toFixed(1)},${h} ${line} ${x(n - 1).toFixed(1)},${h}`} fill={color} opacity="0.15" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
