import { useEffect, useMemo, useState } from "react";
import { Database, Plus, Search, Pencil, Trash2, Cable, Lock } from "lucide-react";
import { api, DbConnection } from "../../lib/ipc";
import { confirmDialog, alertDialog } from "../../lib/dialogs";
import { useStore } from "../../store";
import { DbConnectionForm, DB_KINDS } from "./DbConnectionForm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Trang Databases: danh sách kết nối đã lưu; click để mở trong một task mới. */
export function DatabasesPage({ onOpen }: { onOpen: (c: DbConnection) => void }) {
  const hosts = useStore((s) => s.hosts);
  const [conns, setConns] = useState<DbConnection[]>([]);
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);

  async function load() {
    try {
      setConns(await api.getDbConnections());
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return conns;
    return conns.filter((c) => [c.name, c.host, c.username, c.database ?? "", c.kind].some((v) => v.toLowerCase().includes(s)));
  }, [conns, q]);

  async function del(c: DbConnection, e: React.MouseEvent) {
    e.stopPropagation();
    if (!(await confirmDialog({ title: "Delete connection", message: `Remove "${c.name}"? (the saved password is erased)`, confirmText: "Delete", danger: true })))
      return;
    try {
      await api.deleteDbConnection(c.id);
      await load();
    } catch (err) {
      alertDialog({ title: "Databases", message: String(err) });
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">Databases</h1>
        <div className="ml-3 flex flex-1 items-center gap-2 rounded-lg border border-input bg-card px-2.5 sm:max-w-sm">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, host, database…"
            className="w-full bg-transparent py-1.5 text-sm outline-none"
          />
        </div>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="size-4" /> New connection
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {shown.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Database className="size-10 opacity-40" />
            <p>{conns.length === 0 ? "No database connections yet." : "No connections match your search."}</p>
            {conns.length === 0 && (
              <>
                <p className="max-w-md text-center text-xs">
                  MySQL, MariaDB and PostgreSQL — directly or through an SSH tunnel over any of your hosts.
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus className="size-4" /> Add your first connection
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((c) => {
              const via = c.ssh_host_id ? hosts.find((h) => h.id === c.ssh_host_id) : null;
              const label = DB_KINDS.find((k) => k.id === c.kind)?.label ?? c.kind;
              return (
                <div
                  key={c.id}
                  onClick={() => onOpen(c)}
                  className="group relative flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-accent"
                >
                  <span
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-lg",
                      c.kind === "postgres" ? "bg-sky-500/15 text-sky-500" : "bg-amber-500/15 text-amber-500"
                    )}
                    title={label}
                  >
                    <Database className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate font-medium">
                      <span className="truncate">{c.name}</span>
                      {c.read_only && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="read-only" />}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {label} · {c.username}@{c.host}:{c.port}
                      {c.database ? `/${c.database}` : ""}
                    </div>
                    {via && (
                      <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                        <Cable className="size-3" /> via {via.label}
                      </div>
                    )}
                  </div>
                  <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                    <IconBtn
                      title="Edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(c);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </IconBtn>
                    <IconBtn title="Delete" danger onClick={(e) => del(c, e)}>
                      <Trash2 className="size-3.5" />
                    </IconBtn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DbConnectionForm open={formOpen} conn={editing} onOpenChange={setFormOpen} onSaved={load} />
    </div>
  );
}

function IconBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-md bg-card/80 p-1.5 text-muted-foreground hover:bg-background",
        danger ? "hover:text-destructive" : "hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
