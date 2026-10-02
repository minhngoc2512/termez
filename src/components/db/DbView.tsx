import { useEffect, useMemo, useRef, useState } from "react";
import { Play, ListChecks, Square, History, Download, Loader2, AlertTriangle, RotateCw, Database, Lock } from "lucide-react";
import * as dbPool from "../../lib/dbPool";
import type { DbKind, DbTreeNode } from "../../lib/ipc";
import { dialectOf, qualifiedTable, quoteIdent, dangerousStatements, toCsv, toJson } from "../../lib/sql";
import { confirmDialog } from "../../lib/dialogs";
import { copyText } from "../../lib/clipboard";
import { SqlEditor, SqlEditorHandle } from "./SqlEditor";
import { ResultGrid } from "./ResultGrid";
import { SchemaTree, TreeMenuAction } from "./SchemaTree";
import { CopyableError } from "./CopyableError";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NO_DB = "__default__";

const KIND_LABEL: Record<DbKind, string> = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  postgres: "PostgreSQL",
  clickhouse: "ClickHouse",
  redis: "Redis",
};

/** Bao key Redis cho console khi có khoảng trắng / nháy. */
function redisArg(k: string): string {
  return /^[^\s"']+$/.test(k) ? k : '"' + k.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Lệnh xem giá trị theo kiểu key. */
function redisViewCmd(key: string, type: string | null): string {
  const k = redisArg(key);
  switch (type) {
    case "hash": return `HGETALL ${k}`;
    case "list": return `LRANGE ${k} 0 199`;
    case "set": return `SMEMBERS ${k}`;
    case "zset": return `ZRANGE ${k} 0 199 WITHSCORES`;
    case "stream": return `XRANGE ${k} - + COUNT 200`;
    case "ReJSON-RL": return `JSON.GET ${k}`;
    default: return `GET ${k}`;
  }
}
const LIMITS = [100, 500, 1000, 5000, 10000, 50000];

/** Pane Database: cây schema | editor SQL + lưới kết quả. */
export function DbView({ panelId, connId, kind }: { panelId: string; connId: string; kind: DbKind }) {
  // Tạo trạng thái trong lúc render lần đầu để pane có dữ liệu ngay (idempotent).
  dbPool.ensure(panelId, connId, kind);
  const pane = dbPool.useDbPane(panelId);
  const editor = useRef<SqlEditorHandle>(null);
  const [treeW, setTreeW] = useState(250);
  const [editorH, setEditorH] = useState(38); // % chiều cao
  const split = useRef<HTMLDivElement>(null);
  const d = dialectOf(kind);

  // Gợi ý tự động: bảng (và cột đã mở) của database đang chọn.
  const schema = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!pane?.database || d === "redis") return out;
    const base = d === "postgres" ? [pane.database, "public"] : [pane.database];
    for (const t of pane.children[dbPool.pathKey(base)] ?? []) {
      out[t.name] = (pane.children[dbPool.pathKey([...base, t.name])] ?? []).map((c) => c.name);
    }
    return out;
  }, [pane?.database, pane?.children, d]);

  // Nạp danh sách bảng của database đang chọn để có gợi ý.
  useEffect(() => {
    if (!pane?.session || !pane.database || d === "redis") return;
    const base = d === "postgres" ? [pane.database, "public"] : [pane.database];
    if (!pane.children[dbPool.pathKey(base)]) void dbPool.loadChildren(panelId, base);
  }, [pane?.session, pane?.database, pane?.children, d, panelId]);

  if (!pane) return null;
  const scoped = dbPool.scopedDatabase(pane);
  const databases = scoped
    ? [scoped]
    : (pane.children[""] ?? []).filter((n) => n.kind === "database").map((n) => n.name);
  const result = pane.output?.results[pane.activeResult];

  async function run(all: boolean, sqlOverride?: string, database?: string | null) {
    const text = sqlOverride ?? editor.current?.runText(all) ?? "";
    if (!text.trim()) return;
    const danger = dangerousStatements(text, d);
    if (
      danger.length &&
      !(await confirmDialog({
        title: "Run destructive statement?",
        message: danger.join("\n"),
        confirmText: "Run",
        danger: true,
      }))
    )
      return;
    void dbPool.run(panelId, text, database);
  }

  function openTable(path: string[]) {
    const sql = `SELECT * FROM ${qualifiedTable(path, d)} LIMIT 100;`;
    dbPool.update(panelId, { sql });
    void run(false, sql, path[0]);
  }

  function openNode(n: DbTreeNode, path: string[]) {
    if (n.kind !== "key") return openTable(path);
    const sql = redisViewCmd(n.name, n.detail);
    dbPool.update(panelId, { sql });
    void run(false, sql, path[0]);
  }

  function menuFor(n: DbTreeNode, path: string[]): TreeMenuAction[] {
    const items: TreeMenuAction[] = [];
    if (n.kind === "key") {
      const k = redisArg(n.name);
      const exec = (sql: string) => {
        dbPool.update(panelId, { sql });
        void run(false, sql, path[0]);
      };
      return [
        { label: "Show value", run: () => openNode(n, path) },
        { label: "TTL / type", run: () => exec(`TYPE ${k}\nTTL ${k}\nMEMORY USAGE ${k}`) },
        { label: "Copy key", run: () => copyText(n.name).catch(() => {}) },
        {
          label: "Delete key…",
          run: async () => {
            if (await confirmDialog({ title: "Delete key", message: `DEL ${n.name}`, confirmText: "Delete", danger: true })) {
              await dbPool.run(panelId, `DEL ${k}`, path[0]);
              void dbPool.loadChildren(panelId, path.slice(0, -1));
            }
          },
        },
      ];
    }
    if (n.kind === "info") return [];
    if (n.kind === "table" || n.kind === "view") {
      const q = qualifiedTable(path, d);
      items.push({ label: "Select first 100 rows", run: () => openTable(path) });
      items.push({
        label: "Count rows",
        run: () => {
          const sql = `SELECT COUNT(*) FROM ${q};`;
          dbPool.update(panelId, { sql });
          void run(false, sql, path[0]);
        },
      });
      items.push({ label: "Copy qualified name", run: () => copyText(q).catch(() => {}) });
    }
    if (n.kind === "column") items.push({ label: "Copy name", run: () => copyText(quoteIdent(n.name, d)).catch(() => {}) });
    if (n.kind === "database") items.push({ label: "Use as current database", run: () => dbPool.update(panelId, { database: n.name }) });
    if (n.kind !== "column") items.push({ label: "Refresh", run: () => void dbPool.loadChildren(panelId, path) });
    return items;
  }

  function exportAs(fmt: "csv" | "json") {
    if (!result) return;
    const text = fmt === "csv" ? toCsv(result) : toJson(result);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: fmt === "csv" ? "text/csv" : "application/json" }));
    a.download = `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Kéo thanh chia ngang (cây | nội dung) và dọc (editor / kết quả).
  function dragTree(e: React.MouseEvent) {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = treeW;
    const move = (ev: MouseEvent) => setTreeW(Math.min(Math.max(w0 + ev.clientX - x0, 160), 600));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function dragSplit(e: React.MouseEvent) {
    e.preventDefault();
    const box = split.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => setEditorH(Math.min(Math.max(((ev.clientY - box.top) / box.height) * 100, 12), 85));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (pane.status !== "ready") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        {pane.status === "connecting" ? (
          <>
            <Loader2 className="size-6 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Connecting…</div>
          </>
        ) : (
          <>
            <AlertTriangle className="size-6 text-destructive" />
            <CopyableError text={pane.error ?? ""} className="w-full max-w-lg text-left" />
            <Button size="sm" onClick={() => dbPool.connect(panelId)}>
              <RotateCw className="size-4" /> Retry
            </Button>
          </>
        )}
      </div>
    );
  }

  const hist = dbPool.history(connId);

  return (
    <div className="flex h-full bg-background text-foreground">
      <div className="shrink-0 border-r border-border bg-sidebar" style={{ width: treeW }}>
        <SchemaTree panelId={panelId} pane={pane} onOpenNode={openNode} menuFor={menuFor} />
      </div>
      <div className="w-1 shrink-0 cursor-col-resize hover:bg-primary/40" onMouseDown={dragTree} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
          <Button size="sm" onClick={() => run(false)} disabled={pane.running} title="Run statement at cursor or selection (Ctrl+Enter)">
            <Play className="size-4" /> Run
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(true)} disabled={pane.running} title="Run whole script (Ctrl+Shift+Enter)">
            <ListChecks className="size-4" /> Run all
          </Button>
          {pane.running && (
            <Button size="sm" variant="outline" onClick={() => dbPool.cancel(panelId)} title="Cancel running statement">
              <Square className="size-3.5 fill-current" /> Stop
            </Button>
          )}

          <Select
            value={pane.database ?? NO_DB}
            onValueChange={(v) => dbPool.update(panelId, { database: v === NO_DB ? null : v })}
          >
            <SelectTrigger size="sm" className="ml-1 h-8 max-w-52" title="Database the statements run in">
              <Database className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!pane.database && <SelectItem value={NO_DB}>(no database)</SelectItem>}
              {[...new Set([...(pane.database ? [pane.database] : []), ...databases])].map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(pane.limit)} onValueChange={(v) => dbPool.update(panelId, { limit: Number(v) })}>
            <SelectTrigger size="sm" className="h-8" title="Maximum rows fetched per result">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMITS.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  {l.toLocaleString()} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" title="Query history" disabled={hist.length === 0}>
                <History className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-96 w-[28rem] overflow-y-auto">
              <DropdownMenuLabel>Recent queries</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {hist.map((h) => (
                <DropdownMenuItem
                  key={h.at}
                  onSelect={() => {
                    dbPool.update(panelId, { sql: h.sql });
                    editor.current?.focus();
                  }}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="w-full truncate font-mono text-xs">{h.sql.replace(/\s+/g, " ")}</span>
                  <span className="text-[10px] text-muted-foreground">{new Date(h.at).toLocaleString()}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {pane.session?.read_only && (
            <span
              className="ml-auto flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-500"
              title="Only SELECT / SHOW / DESCRIBE / EXPLAIN can run on this connection"
            >
              <Lock className="size-3.5" /> Read-only
            </span>
          )}
          <span
            className={cn("truncate text-xs text-muted-foreground", !pane.session?.read_only && "ml-auto")}
            title={pane.session?.server_version}
          >
            {KIND_LABEL[kind]} {pane.session?.server_version}
          </span>
        </div>

        <div ref={split} className="flex min-h-0 flex-1 flex-col">
          <div style={{ height: `${editorH}%` }} className="min-h-0">
            <SqlEditor
              ref={editor}
              value={pane.sql}
              dialect={d}
              schema={schema}
              onChange={(sql) => dbPool.update(panelId, { sql })}
              onRun={(all) => void run(all)}
            />
          </div>
          <div className="h-1 shrink-0 cursor-row-resize border-y border-border bg-sidebar hover:bg-primary/40" onMouseDown={dragSplit} />

          {/* Kết quả */}
          <div className="flex min-h-0 flex-1 flex-col">
            {pane.output && pane.output.results.length > 1 && (
              <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1">
                {pane.output.results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => dbPool.update(panelId, { activeResult: i })}
                    className={cn(
                      "shrink-0 rounded px-2 py-0.5 text-xs",
                      i === pane.activeResult ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {r.columns.length ? `Result ${i + 1} · ${r.rows.length}` : `#${i + 1} · ${r.affected ?? 0} affected`}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-3 border-b border-border px-3 py-1 text-xs text-muted-foreground">
              {pane.running ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" /> Running…
                </span>
              ) : pane.queryError ? (
                <span className="text-destructive">Error</span>
              ) : result ? (
                <>
                  <span>
                    {result.columns.length
                      ? `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"}`
                      : `${(result.affected ?? 0).toLocaleString()} row(s) affected`}
                  </span>
                  {result.truncated && (
                    <span className="text-amber-500">limited to {pane.limit.toLocaleString()} — raise the row limit or add LIMIT</span>
                  )}
                  <span>{pane.output!.elapsed_ms} ms</span>
                </>
              ) : (
                <span>Ctrl+Enter runs the statement at the cursor · Ctrl+Shift+Enter runs everything · double-click a table to browse it</span>
              )}
              {result && result.columns.length > 0 && !pane.running && !pane.queryError && (
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => exportAs("csv")}>
                    <Download className="size-3.5" /> CSV
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => exportAs("json")}>
                    <Download className="size-3.5" /> JSON
                  </Button>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {pane.queryError ? (
                <CopyableError text={pane.queryError} className="h-full p-3" />
              ) : result && result.columns.length > 0 ? (
                <ResultGrid key={`${pane.output!.elapsed_ms}-${pane.activeResult}`} rs={result} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
