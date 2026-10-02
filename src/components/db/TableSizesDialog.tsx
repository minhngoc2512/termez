import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Loader2, Search, Table2 } from "lucide-react";
import { api, DbTableSizes, DbTableStat } from "../../lib/ipc";
import { copyText } from "../../lib/clipboard";
import { fmtBytes } from "../MonitorView";
import { CopyableError } from "./CopyableError";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type SortKey = "name" | "rows" | "total_bytes" | "data_bytes" | "index_bytes" | "uncompressed_bytes";

const fmtRows = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString());

/** Popup từ mục Disk usage của Monitor: kích thước + số dòng từng bảng của một database. */
export function TableSizesDialog({
  sessionId,
  database,
  kind,
  onClose,
}: {
  sessionId: string;
  database: string | null;
  kind?: string;
  onClose: () => void;
}) {
  // MongoDB: collection / document thay cho table / row.
  const mongo = kind === "mongodb";
  const tableNoun = mongo ? "collection" : "table";
  const rowNoun = mongo ? "documents" : "rows";
  const [data, setData] = useState<DbTableSizes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "total_bytes", desc: true });

  useEffect(() => {
    if (!database) return;
    setData(null);
    setError(null);
    setQ("");
    api
      .dbTableSizes(sessionId, database)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [sessionId, database]);

  const ch = data?.tables.some((t) => t.uncompressed_bytes !== null) ?? false;
  const cols: { key: SortKey; label: string; num: boolean }[] = [
    { key: "name", label: mongo ? "Collection" : "Table", num: false },
    { key: "rows", label: (mongo ? "Documents" : "Rows") + (data && !data.rows_exact ? " (est.)" : ""), num: true },
    { key: "total_bytes", label: ch ? "On disk" : "Total size", num: true },
    ...(ch
      ? [{ key: "uncompressed_bytes" as SortKey, label: "Uncompressed", num: true }]
      : [
          { key: "data_bytes" as SortKey, label: "Data", num: true },
          { key: "index_bytes" as SortKey, label: "Indexes", num: true },
        ]),
  ];

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (data?.tables ?? []).filter((t) => !s || t.name.toLowerCase().includes(s));
    const k = sort.key;
    return [...list].sort((a, b) => {
      const r =
        k === "name"
          ? a.name.localeCompare(b.name, undefined, { numeric: true })
          : ((a[k] as number | null) ?? -1) - ((b[k] as number | null) ?? -1);
      return sort.desc ? -r : r;
    });
  }, [data, q, sort]);

  const totalBytes = rows.reduce((n, t) => n + t.total_bytes, 0);
  const totalRows = rows.reduce((n, t) => n + (t.rows ?? 0), 0);
  const cell = (t: DbTableStat, k: SortKey) => {
    const v = t[k];
    if (k === "rows") return fmtRows(v as number | null);
    return v === null ? "—" : fmtBytes(v as number);
  };

  return (
    <Dialog open={database !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="size-5 text-primary" /> <span className="font-mono">{database}</span>
          </DialogTitle>
        </DialogHeader>

        {error ? (
          <CopyableError text={error} />
        ) : !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading {tableNoun} sizes…
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span>
                <b>{rows.length.toLocaleString()}</b> {rows.length === 1 ? tableNoun : `${tableNoun}s`}
              </span>
              <span>
                <b>{fmtBytes(totalBytes)}</b> {ch ? "on disk" : "total"}
              </span>
              <span>
                <b>{fmtRows(totalRows)}</b> {rowNoun}{data.rows_exact ? "" : " (estimated)"}
              </span>
              <div className="ml-auto flex items-center gap-1.5 rounded-md border border-input bg-background px-2">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={`Filter ${tableNoun}s…`}
                  className="w-48 bg-transparent py-1 text-xs outline-none"
                />
              </div>
            </div>
            {!data.rows_exact && (
              <p className="-mt-1 text-[11px] text-muted-foreground">
                Row counts are the server's statistics (fast, approximate) — use SELECT COUNT(*) for an exact number.
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    {cols.map((c) => (
                      <th key={c.key} className={cn("whitespace-nowrap px-3 py-2 font-medium", c.num && "text-right")}>
                        <button
                          onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== "name" }))}
                          className={cn("inline-flex items-center gap-1 hover:text-foreground", sort.key === c.key && "text-foreground")}
                        >
                          {c.label}
                          {sort.key === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      </th>
                    ))}
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={cols.length + 1} className="px-3 py-4 text-center font-sans text-muted-foreground">
                        {data.tables.length === 0 ? `No ${tableNoun}s in this database.` : `No ${tableNoun}s match.`}
                      </td>
                    </tr>
                  ) : (
                    rows.map((t) => {
                      const share = totalBytes > 0 ? (t.total_bytes / totalBytes) * 100 : 0;
                      return (
                        <tr key={t.name} className="group border-t border-border/60 hover:bg-accent/40">
                          <td className="max-w-[18rem] px-3 py-1.5">
                            <div className="selectable truncate" title={t.engine ? `${t.name} · ${t.engine}` : t.name}>
                              {t.name}
                            </div>
                            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
                              <div className="h-full bg-primary/70" style={{ width: `${share}%` }} />
                            </div>
                          </td>
                          {cols.slice(1).map((c) => (
                            <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-right">
                              {cell(t, c.key)}
                            </td>
                          ))}
                          <td className="px-1">
                            <button
                              title="Copy table name"
                              onClick={() => copyText(t.name).catch(() => {})}
                              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                            >
                              <Copy className="size-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
