import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Server, X } from "lucide-react";
import { api, DbConnection, Host } from "../lib/ipc";
import { useStore } from "../store";
import { DbIcon } from "./db/DbIcon";
import { cn } from "@/lib/utils";

export type PickerMode = "hosts" | "databases";

interface Props {
  open: boolean;
  /** Danh sách mở ra lúc đầu (theo loại task đang xem); người dùng đổi được. */
  mode: PickerMode;
  onOpenChange: (o: boolean) => void;
  onPick: (h: Host) => void;
  onPickDb: (c: DbConnection) => void;
}

type Item = { kind: "host"; host: Host } | { kind: "db"; conn: DbConnection };

/** Popup chọn/search host (SSH session) hoặc kết nối database để mở một task mới. */
export function HostPicker({ open, mode: initialMode, onOpenChange, onPick, onPickDb }: Props) {
  const hosts = useStore((s) => s.hosts);
  const [mode, setMode] = useState<PickerMode>(initialMode);
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
      api.getDbConnections().then(setConns).catch(() => setConns([]));
    }
  }, [open, initialMode]);

  const results: Item[] = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (mode === "databases") {
      const list = (conns ?? []).filter(
        (c) =>
          !s ||
          c.name.toLowerCase().includes(s) ||
          c.host.toLowerCase().includes(s) ||
          c.kind.includes(s) ||
          (c.database ?? "").toLowerCase().includes(s)
      );
      return list.slice(0, 50).map((conn) => ({ kind: "db", conn }));
    }
    const list = s
      ? hosts.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.address.toLowerCase().includes(s) ||
            h.username.toLowerCase().includes(s)
        )
      : hosts;
    return list.slice(0, 50).map((host) => ({ kind: "host", host }));
  }, [hosts, conns, q, mode]);

  useEffect(() => setIdx(0), [q, mode]);

  if (!open) return null;

  function choose(it: Item) {
    if (it.kind === "host") onPick(it.host);
    else onPickDb(it.conn);
    onOpenChange(false);
  }
  function switchMode(m: PickerMode) {
    setMode(m);
    inputRef.current?.focus();
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { if (results[idx]) choose(results[idx]); }
    else if (e.key === "Tab") { e.preventDefault(); switchMode(mode === "hosts" ? "databases" : "hosts"); }
    else if (e.key === "Escape") onOpenChange(false);
  }

  const empty =
    mode === "hosts"
      ? hosts.length === 0 ? "No hosts yet." : "No host found."
      : conns === null ? "Loading…" : conns.length === 0 ? "No database connections yet." : "No connection found.";

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === "hosts" ? "Search a host by name, IP or user…" : "Search a database connection…"}
            className="w-full bg-transparent py-3 text-sm outline-none"
          />
          <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5 text-xs" title="Tab to switch">
            {(["hosts", "databases"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors",
                  mode === m ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {m === "hosts" ? "SSH hosts" : "Databases"}
              </button>
            ))}
          </div>
          <button onClick={() => onOpenChange(false)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{empty}</div>
          ) : (
            results.map((it, i) => (
              <button
                key={it.kind === "host" ? it.host.id : it.conn.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(it)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  i === idx ? "bg-accent" : "hover:bg-accent"
                )}
              >
                {it.kind === "host" ? (
                  <>
                    <Server className="size-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{it.host.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {it.host.username}@{it.host.address}
                        {it.host.port !== 22 ? `:${it.host.port}` : ""}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <DbIcon kind={it.conn.kind} className="size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{it.conn.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {it.conn.kind === "bigquery" ? "BigQuery" : `${it.conn.host}:${it.conn.port}`}
                        {it.conn.database ? ` / ${it.conn.database}` : ""}
                      </div>
                    </div>
                    {it.conn.read_only && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-500">RO</span>}
                  </>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
