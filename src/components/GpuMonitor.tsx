import { useMemo, useState } from "react";
import { Gpu as GpuIcon, ArrowDown, ArrowUp } from "lucide-react";
import type { Gpu, GpuProc } from "../lib/ipc";
import { fmtBytes } from "./MonitorView";
import { cn } from "@/lib/utils";

/** Lịch sử % GPU và % bộ nhớ của từng card, giữ ở MonitorView. */
export type GpuHistory = Map<number, { util: number[]; mem: number[] }>;

/** ~5 phút ở nhịp 2 giây: bậc thang hẹp, gần với mỗi cột một mẫu của nvtop. */
const KEEP = 150;

export function pushGpuHistory(h: GpuHistory, gpus: Gpu[]) {
  for (const g of gpus) {
    let e = h.get(g.index);
    if (!e) h.set(g.index, (e = { util: [], mem: [] }));
    e.util.push(g.util ?? 0);
    e.mem.push(memPct(g));
    if (e.util.length > KEEP) e.util.shift();
    if (e.mem.length > KEEP) e.mem.shift();
  }
}

function memPct(g: Gpu) {
  return g.mem_used_mb != null && g.mem_total_mb ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0;
}
const na = (v: number | null | undefined, unit = "", digits = 0) => (v == null ? "N/A" : `${v.toFixed(digits)}${unit}`);
/** MiB → "64.7Gi" như nvtop. */
const gib = (mb: number | null) => (mb == null ? "N/A" : mb >= 1024 ? `${(mb / 1024).toFixed(1)}Gi` : `${mb.toFixed(0)}Mi`);
const mbps = (v: number | null) => (v == null ? "N/A" : `${fmtBytes(v * 1024 * 1024)}/s`);

/** Màu theo kiểu nvtop: nhãn xanh dương, số liệu xanh lá, bộ nhớ cam. */
const L = "text-sky-400";
const UTIL = "#38bdf8";
const MEM = "#fb923c";

/** Tab GPU: card + biểu đồ ở trên, bảng tiến trình chiếm phần còn lại và tự cuộn. */
export function GpuTab({ gpus, procs, history }: { gpus: Gpu[]; procs: GpuProc[]; history: GpuHistory }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="shrink-0 rounded-xl border border-border bg-card p-3 font-mono text-xs leading-5">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 xl:grid-cols-2">
          {gpus.map((g) => <Device key={g.index} g={g} />)}
        </div>
        <div className={cn("mt-4 grid grid-cols-1 gap-3", gpus.length > 1 && "lg:grid-cols-2", gpus.length > 4 && "2xl:grid-cols-4")}>
          {gpus.map((g) => {
            const h = history.get(g.index);
            return <HistoryChart key={g.index} index={g.index} util={h?.util ?? []} mem={h?.mem ?? []} />;
          })}
        </div>
      </div>
      <ProcessTable gpus={gpus} procs={procs} />
    </div>
  );
}

/** Tóm tắt mỗi card một ô ở tab Overview; bấm để sang tab GPU. */
export function GpuSummary({ gpus, onOpen }: { gpus: Gpu[]; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="mt-4 block w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/60">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <GpuIcon className="size-4" /> GPUs · {gpus.length}
        <span className="ml-auto font-normal normal-case tracking-normal text-primary">Details →</span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
        {gpus.map((g) => (
          <div key={g.index} className="min-w-0">
            <div className="flex justify-between gap-2">
              <span className={L}>GPU{g.index}</span>
              <span className="truncate text-muted-foreground">
                {na(g.util, "%")} · {gib(g.mem_used_mb)}/{gib(g.mem_total_mb)} · <span className={cn((g.temp ?? 0) >= 80 && "text-red-400")}>{na(g.temp, "°C")}</span>
              </span>
            </div>
            <div className="mt-0.5 grid grid-cols-2 gap-1">
              <Meter pct={g.util ?? 0} color={UTIL} />
              <Meter pct={memPct(g)} color={MEM} />
            </div>
          </div>
        ))}
      </div>
    </button>
  );
}

function Meter({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function Device({ g }: { g: Gpu }) {
  const hot = (g.temp ?? 0) >= 80;
  const pow = g.power_w != null && g.power_limit_w ? g.power_w / g.power_limit_w : 0;
  return (
    <div className="min-w-0">
      <div className="truncate">
        <span className={L}>Device {g.index}</span> [{g.name}]
        {g.pcie_gen != null && <> <span className={L}>PCIe GEN</span> {g.pcie_gen}@{na(g.pcie_width)}x</>}
        {" "}<span className={L}><ArrowDown className="inline size-3" />RX:</span> {mbps(g.rx_mbps)}
        {" "}<span className={L}><ArrowUp className="inline size-3" />TX:</span> {mbps(g.tx_mbps)}
      </div>
      <div className="truncate">
        <span className={L}>GPU</span> {na(g.clock_gr, "MHz")} <span className={L}>MEM</span> {na(g.clock_mem, "MHz")}{" "}
        <span className={L}>TEMP</span> <span className={cn(hot && "text-red-400")}>{na(g.temp, "°C")}</span>{" "}
        <span className={L}>FAN</span> {na(g.fan, "%")}{" "}
        <span className={L}>POW</span> <span className={cn(pow > 0.9 && "text-orange-400")}>{na(g.power_w)} / {na(g.power_limit_w)} W</span>
      </div>
      <div className="mt-0.5 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3">
        <Bar label="GPU" pct={g.util ?? 0} text={na(g.util, "%")} color="#4ade80" />
        <Bar label="MEM" pct={memPct(g)} text={`${gib(g.mem_used_mb)}/${gib(g.mem_total_mb)}`} color="#4ade80" />
      </div>
    </div>
  );
}

/** Thanh kiểu "GPU[||||||    15%]": vạch dọc vẽ bằng gradient lặp. */
function Bar({ label, pct, text, color }: { label: string; pct: number; text: string; color: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex min-w-0 items-center">
      <span className={L}>{label}</span>
      <span>[</span>
      <div className="relative h-4 min-w-0 flex-1">
        <div
          className="absolute inset-y-0.5 left-0"
          style={{ width: `${p}%`, background: `repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 4px)` }}
        />
        <span className="absolute inset-y-0 right-0.5 bg-card/70 pl-1 leading-4">{text}</span>
      </div>
      <span>]</span>
    </div>
  );
}

/** Biểu đồ bậc thang 0–100% như nvtop: mẫu mới nhất ở mép phải. */
function HistoryChart({ index, util, mem }: { index: number; util: number[]; mem: number[] }) {
  const w = 300, h = 100;
  const path = (data: number[]) => {
    if (data.length === 0) return "";
    const step = w / (KEEP - 1);
    const x0 = w - (data.length - 1) * step;
    const y = (v: number) => (h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1);
    // Như nvtop: phần chưa có dữ liệu là đường nằm ở 0 từ mép trái, không bắt đầu lơ lửng giữa chừng.
    let d = x0 > 0 ? `M0,${h}H${x0.toFixed(1)}V${y(data[0])}` : `M${x0.toFixed(1)},${y(data[0])}`;
    for (let i = 1; i < data.length; i++) d += `H${(x0 + i * step).toFixed(1)}V${y(data[i])}`;
    return d;
  };
  const last = (a: number[]) => (a.length ? a[a.length - 1].toFixed(0) : "–");
  return (
    <div className="flex gap-1">
      <div className="flex w-7 flex-col justify-between py-0.5 text-right text-[10px] leading-none text-muted-foreground">
        {[100, 75, 50, 25, 0].map((v) => <span key={v}>{v}</span>)}
      </div>
      <div className="relative h-36 flex-1 rounded border border-emerald-500/50">
        <div className="absolute left-1.5 top-1 z-10 leading-4">
          <div><span style={{ color: UTIL }}>GPU{index} %</span> <span className="text-muted-foreground">{last(util)}</span></div>
          <div><span style={{ color: MEM }}>GPU{index} mem%</span> <span className="text-muted-foreground">{last(mem)}</span></div>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" shapeRendering="crispEdges" className="absolute inset-0 h-full w-full">
          {[25, 50, 75].map((v) => (
            <line key={v} x1="0" x2={w} y1={h - v} y2={h - v} stroke="currentColor" strokeOpacity="0.08" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={path(mem)} fill="none" stroke={MEM} strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
          <path d={path(util)} fill="none" stroke={UTIL} strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  );
}

type SortKey = "pid" | "user" | "gpu" | "sm" | "mem" | "cpu" | "host" | "command";
const COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "pid", label: "PID", right: true },
  { key: "user", label: "USER" },
  { key: "gpu", label: "DEV", right: true },
  { key: "gpu", label: "TYPE" },
  { key: "sm", label: "GPU", right: true },
  { key: "mem", label: "GPU MEM", right: true },
  { key: "cpu", label: "CPU", right: true },
  { key: "host", label: "HOST MEM", right: true },
  { key: "command", label: "Command" },
];

function ProcessTable({ gpus, procs }: { gpus: Gpu[]; procs: GpuProc[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "mem", desc: true });
  const total = useMemo(() => new Map(gpus.map((g) => [g.index, g.mem_total_mb ?? 0])), [gpus]);
  const rows = useMemo(() => {
    const v = (p: GpuProc): number | string => {
      switch (sort.key) {
        case "pid": return p.pid;
        case "user": return p.user ?? "";
        case "gpu": return p.gpu;
        case "sm": return p.sm ?? -1;
        case "mem": return p.mem_used_mb ?? -1;
        case "cpu": return p.cpu ?? -1;
        case "host": return p.host_mem_kb ?? -1;
        case "command": return p.command;
      }
    };
    return [...procs].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [procs, sort]);

  return (
    <div className="mt-3 min-h-48 flex-1 overflow-auto rounded-xl border border-border bg-card font-mono text-xs">
      <table className="w-full whitespace-nowrap">
        <thead className="sticky top-0 z-10">
          <tr className="bg-emerald-600 text-left text-black">
            {COLS.map((c) => (
              <th
                key={c.label}
                onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== "user" && c.key !== "command" }))}
                className={cn("cursor-pointer select-none px-2 py-1 font-normal", c.right && "text-right", sort.key === c.key && c.label !== "TYPE" && "bg-sky-400")}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={COLS.length} className="px-2 py-3 text-center text-muted-foreground">No processes on the GPUs.</td></tr>
          ) : rows.map((p) => {
            const t = total.get(p.gpu) ?? 0;
            const memPct = p.mem_used_mb != null && t > 0 ? (p.mem_used_mb / t) * 100 : null;
            return (
              <tr key={`${p.gpu}:${p.pid}`} className="border-t border-border/40 hover:bg-accent/50">
                <td className="px-2 text-right">{p.pid}</td>
                <td className="px-2">{p.user ?? "?"}</td>
                <td className="px-2 text-right">{p.gpu}</td>
                <td className="px-2 text-red-400">{p.kind === "C" ? "Compute" : p.kind === "G" ? "Graphic" : p.kind}</td>
                <td className="px-2 text-right">{na(p.sm, "%")}</td>
                <td className="px-2 text-right">
                  {p.mem_used_mb == null ? "N/A" : `${p.mem_used_mb.toFixed(0)}MiB`}
                  {memPct != null && <span className="ml-2 inline-block w-9 text-muted-foreground">{memPct.toFixed(0)}%</span>}
                </td>
                <td className="px-2 text-right">{na(p.cpu, "%")}</td>
                <td className="px-2 text-right">{p.host_mem_kb == null ? "N/A" : `${(p.host_mem_kb / 1024).toFixed(0)}MiB`}</td>
                <td className="max-w-0 truncate px-2" style={{ width: "100%" }} title={p.command}>{p.command}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
