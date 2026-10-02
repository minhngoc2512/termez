// Cấu hình màn Monitor theo từng loại database: tính chỉ số hiển thị (tốc độ từ
// chênh lệch hai lần đo, tỉ lệ cache hit…) và danh sách biểu đồ.
import type { LucideIcon } from "lucide-react";
import { Activity, ArrowDownUp, Cable, Gauge, MemoryStick, Rows3, Users } from "lucide-react";
import { fmtBytes } from "../MonitorView";

export type Vals = Record<string, number>;

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface CardSpec {
  title: string;
  icon: LucideIcon;
  series: Series[];
  /** Trục Y cố định (vd 100 cho %); bỏ trống = theo giá trị lớn nhất. */
  max?: number;
  value: (d: Vals) => string;
  sub?: (d: Vals) => string;
}

export interface KindSpec {
  derive: (prev: Vals | null, cur: Vals, dt: number) => Vals;
  cards: CardSpec[];
  uptime: (v: Vals) => number | undefined;
  breakdownTitle: string;
  breakdownUnit: "bytes" | "count";
}

const GREEN = "#22c55e";
const CYAN = "#06b6d4";
const AMBER = "#f59e0b";
const FUCHSIA = "#d946ef";
const RED = "#ef4444";

/** Tốc độ / giây của một bộ đếm luỹ kế (0 ở lần đo đầu hoặc khi server khởi động lại). */
function rater(prev: Vals | null, cur: Vals, dt: number) {
  return (k: string) => {
    if (!prev || prev[k] === undefined || cur[k] === undefined) return 0;
    return Math.max(0, (cur[k] - prev[k]) / dt);
  };
}

/** % trúng = hit / (hit + miss) trên phần chênh lệch; NaN khi không có truy cập nào. */
function hitRatio(prev: Vals | null, cur: Vals, hit: string, miss: string): number {
  if (!prev) return NaN;
  const h = (cur[hit] ?? 0) - (prev[hit] ?? 0);
  const m = (cur[miss] ?? 0) - (prev[miss] ?? 0);
  return h + m > 0 ? (h / (h + m)) * 100 : NaN;
}

export const fmtNum = (n: number) =>
  !Number.isFinite(n)
    ? "—"
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e4
        ? `${(n / 1e3).toFixed(1)}k`
        : Number.isInteger(n) || n >= 100
          ? n.toFixed(0)
          : n.toFixed(n < 10 ? 1 : 0);
const pct = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : "—");

export const SPECS: Record<string, KindSpec> = {
  mysql: {
    derive: (prev, cur, dt) => {
      const r = rater(prev, cur, dt);
      const req = prev ? (cur.Innodb_buffer_pool_read_requests ?? 0) - (prev.Innodb_buffer_pool_read_requests ?? 0) : 0;
      const disk = prev ? (cur.Innodb_buffer_pool_reads ?? 0) - (prev.Innodb_buffer_pool_reads ?? 0) : 0;
      return {
        qps: r("Questions"),
        reads: r("Com_select"),
        writes: r("Com_insert") + r("Com_update") + r("Com_delete"),
        connected: cur.Threads_connected ?? 0,
        running: cur.Threads_running ?? 0,
        maxConn: cur.max_connections ?? 0,
        netIn: r("Bytes_received"),
        netOut: r("Bytes_sent"),
        bpHit: req > 0 ? (1 - disk / req) * 100 : NaN,
        slowPerMin: r("Slow_queries") * 60,
        lockWaits: r("Innodb_row_lock_waits") * 60,
      };
    },
    cards: [
      {
        title: "Queries / s",
        icon: Activity,
        series: [
          { key: "qps", label: "all", color: GREEN },
          { key: "reads", label: "select", color: CYAN },
          { key: "writes", label: "write", color: AMBER },
        ],
        value: (d) => fmtNum(d.qps),
        sub: (d) => `${fmtNum(d.reads)} select · ${fmtNum(d.writes)} insert/update/delete`,
      },
      {
        title: "Connections",
        icon: Users,
        series: [
          { key: "connected", label: "connected", color: GREEN },
          { key: "running", label: "running", color: AMBER },
        ],
        value: (d) => fmtNum(d.connected),
        sub: (d) => `${fmtNum(d.running)} running · max ${fmtNum(d.maxConn)}`,
      },
      {
        title: "Network",
        icon: ArrowDownUp,
        series: [
          { key: "netIn", label: "in", color: CYAN },
          { key: "netOut", label: "out", color: FUCHSIA },
        ],
        value: (d) => `↓ ${fmtBytes(d.netIn)}/s  ↑ ${fmtBytes(d.netOut)}/s`,
      },
      {
        title: "InnoDB buffer pool hit",
        icon: Gauge,
        series: [{ key: "bpHit", label: "hit %", color: GREEN }],
        max: 100,
        value: (d) => pct(d.bpHit),
        sub: (d) => `${fmtNum(d.slowPerMin)} slow queries/min · ${fmtNum(d.lockWaits)} row-lock waits/min`,
      },
    ],
    uptime: (v) => v.Uptime,
    breakdownTitle: "Database size (data + indexes)",
    breakdownUnit: "bytes",
  },

  postgres: {
    derive: (prev, cur, dt) => {
      const r = rater(prev, cur, dt);
      return {
        commits: r("xact_commit"),
        rollbacks: r("xact_rollback"),
        tps: r("xact_commit") + r("xact_rollback"),
        active: cur.sessions_active ?? 0,
        idleTx: cur.sessions_idle_tx ?? 0,
        total: cur.sessions_total ?? 0,
        maxConn: cur.max_connections ?? 0,
        rowsRead: r("rows_read"),
        rowsWritten: r("rows_written"),
        cacheHit: hitRatio(prev, cur, "blks_hit", "blks_read"),
        locks: cur.locks_waiting ?? 0,
        deadlocks: cur.deadlocks ?? 0,
        tempBytes: r("temp_bytes"),
      };
    },
    cards: [
      {
        title: "Transactions / s",
        icon: Activity,
        series: [
          { key: "commits", label: "commit", color: GREEN },
          { key: "rollbacks", label: "rollback", color: RED },
        ],
        value: (d) => fmtNum(d.tps),
        sub: (d) => `${fmtNum(d.commits)} commit · ${fmtNum(d.rollbacks)} rollback`,
      },
      {
        title: "Sessions",
        icon: Users,
        series: [
          { key: "active", label: "active", color: GREEN },
          { key: "idleTx", label: "idle in transaction", color: AMBER },
        ],
        value: (d) => `${fmtNum(d.active)} active`,
        sub: (d) => `${fmtNum(d.total)} total · max ${fmtNum(d.maxConn)} · ${fmtNum(d.idleTx)} idle in transaction`,
      },
      {
        title: "Rows / s",
        icon: Rows3,
        series: [
          { key: "rowsRead", label: "read", color: CYAN },
          { key: "rowsWritten", label: "written", color: FUCHSIA },
        ],
        value: (d) => `${fmtNum(d.rowsRead)} read`,
        sub: (d) => `${fmtNum(d.rowsWritten)} written · temp files ${fmtBytes(d.tempBytes)}/s`,
      },
      {
        title: "Cache hit",
        icon: Gauge,
        series: [{ key: "cacheHit", label: "hit %", color: GREEN }],
        max: 100,
        value: (d) => pct(d.cacheHit),
        sub: (d) => `${fmtNum(d.locks)} lock waits · ${fmtNum(d.deadlocks)} deadlocks (total)`,
      },
    ],
    uptime: (v) => v.uptime,
    breakdownTitle: "Database size",
    breakdownUnit: "bytes",
  },

  clickhouse: {
    derive: (prev, cur, dt) => {
      const r = rater(prev, cur, dt);
      return {
        qps: r("ev_Query"),
        selects: r("ev_SelectQuery"),
        inserts: r("ev_InsertQuery"),
        failed: r("ev_FailedQuery"),
        running: cur.m_Query ?? 0,
        merges: cur.m_Merge ?? 0,
        conns: (cur.m_TCPConnection ?? 0) + (cur.m_HTTPConnection ?? 0),
        memory: cur.m_MemoryTracking ?? 0,
        memTotal: cur.a_OSMemoryTotal ?? 0,
        readRows: r("ev_SelectedRows"),
        readBytes: r("ev_SelectedBytes"),
        insertedRows: r("ev_InsertedRows"),
        parts: cur.a_TotalPartsOfMergeTreeTables ?? 0,
        maxParts: cur.a_MaxPartCountForPartition ?? 0,
      };
    },
    cards: [
      {
        title: "Queries / s",
        icon: Activity,
        series: [
          { key: "qps", label: "all", color: GREEN },
          { key: "selects", label: "select", color: CYAN },
          { key: "inserts", label: "insert", color: AMBER },
        ],
        value: (d) => fmtNum(d.qps),
        sub: (d) => `${fmtNum(d.selects)} select · ${fmtNum(d.inserts)} insert · ${fmtNum(d.failed)} failed`,
      },
      {
        title: "Running",
        icon: Cable,
        series: [
          { key: "running", label: "queries", color: GREEN },
          { key: "merges", label: "merges", color: AMBER },
        ],
        value: (d) => `${fmtNum(d.running)} queries`,
        sub: (d) => `${fmtNum(d.merges)} merges · ${fmtNum(d.conns)} connections`,
      },
      {
        title: "Memory",
        icon: MemoryStick,
        series: [{ key: "memory", label: "tracked", color: AMBER }],
        value: (d) => fmtBytes(d.memory),
        sub: (d) => (d.memTotal ? `of ${fmtBytes(d.memTotal)} RAM` : ""),
      },
      {
        title: "Rows / s",
        icon: Rows3,
        series: [
          { key: "readRows", label: "read", color: CYAN },
          { key: "insertedRows", label: "inserted", color: FUCHSIA },
        ],
        value: (d) => `${fmtNum(d.readRows)} read`,
        sub: (d) =>
          `${fmtBytes(d.readBytes)}/s read · ${fmtNum(d.insertedRows)} inserted · parts ${fmtNum(d.parts)} (max/partition ${fmtNum(d.maxParts)})`,
      },
    ],
    uptime: (v) => v.a_Uptime,
    breakdownTitle: "Disk usage by database",
    breakdownUnit: "bytes",
  },

  redis: {
    derive: (prev, cur, dt) => {
      const r = rater(prev, cur, dt);
      return {
        ops: cur.instantaneous_ops_per_sec ?? r("total_commands_processed"),
        memory: cur.used_memory ?? 0,
        rss: cur.used_memory_rss ?? 0,
        maxmemory: cur.maxmemory ?? 0,
        frag: cur.mem_fragmentation_ratio ?? NaN,
        clients: cur.connected_clients ?? 0,
        blocked: cur.blocked_clients ?? 0,
        hit: hitRatio(prev, cur, "keyspace_hits", "keyspace_misses"),
        evicted: r("evicted_keys"),
        expired: r("expired_keys"),
        netIn: r("total_net_input_bytes"),
        netOut: r("total_net_output_bytes"),
        rejected: cur.rejected_connections ?? 0,
      };
    },
    cards: [
      {
        title: "Ops / s",
        icon: Activity,
        series: [{ key: "ops", label: "ops", color: GREEN }],
        value: (d) => fmtNum(d.ops),
      },
      {
        title: "Memory",
        icon: MemoryStick,
        series: [{ key: "memory", label: "used", color: AMBER }],
        value: (d) => fmtBytes(d.memory),
        sub: (d) =>
          `rss ${fmtBytes(d.rss)} · ${d.maxmemory ? `max ${fmtBytes(d.maxmemory)}` : "no maxmemory"} · frag ${Number.isFinite(d.frag) ? d.frag.toFixed(2) : "—"}`,
      },
      {
        title: "Clients",
        icon: Users,
        series: [
          { key: "clients", label: "connected", color: GREEN },
          { key: "blocked", label: "blocked", color: RED },
        ],
        value: (d) => fmtNum(d.clients),
        sub: (d) => `${fmtNum(d.blocked)} blocked · ${fmtNum(d.rejected)} rejected (total)`,
      },
      {
        title: "Cache hit",
        icon: Gauge,
        series: [{ key: "hit", label: "hit %", color: GREEN }],
        max: 100,
        value: (d) => pct(d.hit),
        sub: (d) => `${fmtNum(d.evicted)} evicted/s · ${fmtNum(d.expired)} expired/s`,
      },
      {
        title: "Network",
        icon: ArrowDownUp,
        series: [
          { key: "netIn", label: "in", color: CYAN },
          { key: "netOut", label: "out", color: FUCHSIA },
        ],
        value: (d) => `↓ ${fmtBytes(d.netIn)}/s  ↑ ${fmtBytes(d.netOut)}/s`,
      },
    ],
    uptime: (v) => v.uptime_in_seconds,
    breakdownTitle: "Keys per database",
    breakdownUnit: "count",
  },

  mongodb: {
    derive: (prev, cur, dt) => {
      const r = rater(prev, cur, dt);
      return {
        ops: r("op_insert") + r("op_query") + r("op_update") + r("op_delete") + r("op_getmore") + r("op_command"),
        reads: r("op_query") + r("op_getmore"),
        writes: r("op_insert") + r("op_update") + r("op_delete"),
        commands: r("op_command"),
        conn: cur.conn_current ?? 0,
        available: cur.conn_available ?? 0,
        queued: cur.queued ?? 0,
        cache: cur.wt_cache_bytes ?? 0,
        cacheMax: cur.wt_cache_max ?? 0,
        resident: (cur.mem_resident_mb ?? 0) * 1024 * 1024,
        netIn: r("net_in"),
        netOut: r("net_out"),
      };
    },
    cards: [
      {
        title: "Operations / s",
        icon: Activity,
        series: [
          { key: "reads", label: "query + getmore", color: GREEN },
          { key: "writes", label: "insert/update/delete", color: AMBER },
          { key: "commands", label: "command", color: CYAN },
        ],
        value: (d) => fmtNum(d.ops),
        sub: (d) => `${fmtNum(d.reads)} reads · ${fmtNum(d.writes)} writes · ${fmtNum(d.commands)} commands`,
      },
      {
        title: "Connections",
        icon: Users,
        series: [
          { key: "conn", label: "current", color: GREEN },
          { key: "queued", label: "queued", color: RED },
        ],
        value: (d) => fmtNum(d.conn),
        sub: (d) => `${fmtNum(d.available)} available · ${fmtNum(d.queued)} queued`,
      },
      {
        title: "WiredTiger cache",
        icon: MemoryStick,
        series: [{ key: "cache", label: "in cache", color: AMBER }],
        value: (d) => fmtBytes(d.cache),
        sub: (d) => `${d.cacheMax ? `max ${fmtBytes(d.cacheMax)}` : "—"} · resident ${fmtBytes(d.resident)}`,
      },
      {
        title: "Network",
        icon: ArrowDownUp,
        series: [
          { key: "netIn", label: "in", color: CYAN },
          { key: "netOut", label: "out", color: FUCHSIA },
        ],
        value: (d) => `↓ ${fmtBytes(d.netIn)}/s  ↑ ${fmtBytes(d.netOut)}/s`,
      },
    ],
    uptime: (v) => v.uptime,
    breakdownTitle: "Disk usage by database",
    breakdownUnit: "bytes",
  },

  // BigQuery không có bộ đếm của server: số job hiện tại + thống kê job 10 phút gần nhất.
  bigquery: {
    derive: (_prev, cur) => ({
      running: cur.running ?? 0,
      pending: cur.pending ?? 0,
      done: cur.done_10m ?? 0,
      failed: cur.failed_10m ?? 0,
      bytes: cur.bytes_10m ?? 0,
      billed: cur.billed_10m ?? 0,
      slotSec: (cur.slot_ms_10m ?? 0) / 1000,
    }),
    cards: [
      {
        title: "Jobs now",
        icon: Activity,
        series: [
          { key: "running", label: "running", color: GREEN },
          { key: "pending", label: "pending", color: AMBER },
        ],
        value: (d) => `${fmtNum(d.running)} running`,
        sub: (d) => `${fmtNum(d.pending)} pending`,
      },
      {
        title: "Finished · last 10 min",
        icon: Rows3,
        series: [
          { key: "done", label: "finished", color: CYAN },
          { key: "failed", label: "failed", color: RED },
        ],
        value: (d) => fmtNum(d.done),
        sub: (d) => `${fmtNum(d.failed)} failed`,
      },
      {
        title: "Bytes processed · last 10 min",
        icon: ArrowDownUp,
        series: [
          { key: "bytes", label: "processed", color: FUCHSIA },
          { key: "billed", label: "billed", color: AMBER },
        ],
        value: (d) => fmtBytes(d.bytes),
        // Giá on-demand công bố: $6.25 / TiB.
        sub: (d) => `billed ${fmtBytes(d.billed)} ≈ $${((d.billed / 2 ** 40) * 6.25).toFixed(d.billed ? 4 : 0)} on-demand`,
      },
      {
        title: "Slot time · last 10 min",
        icon: Gauge,
        series: [{ key: "slotSec", label: "slot-seconds", color: GREEN }],
        value: (d) => `${fmtNum(d.slotSec)} slot·s`,
      },
    ],
    uptime: () => undefined,
    breakdownTitle: "Storage by dataset (logical)",
    breakdownUnit: "bytes",
  },
};

SPECS.mariadb = SPECS.mysql;

