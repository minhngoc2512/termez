import { useEffect, useMemo, useState } from "react";
import {
  Database, Plus, Search, Pencil, Trash2, Cable, Lock, FolderPlus, Folder, FolderOpen, ChevronRight, Activity,
} from "lucide-react";
import { api, DbConnection, DbGroup } from "../../lib/ipc";
import { confirmDialog, alertDialog, promptDialog } from "../../lib/dialogs";
import { useStore } from "../../store";
import { DbConnectionForm, DB_KINDS } from "./DbConnectionForm";
import { DbIcon, dbColor } from "./DbIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DRAG_TYPE = "termez/dbconn";
const UNGROUPED = "__ungrouped__";
const COLLAPSE_KEY = "db-groups-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Trang Databases: kết nối đã lưu, xếp theo nhóm; click để mở trong một task mới. */
/** Project của kết nối BigQuery (lưu trong options). */
function bqProject(options: string | null): string {
  try {
    return (JSON.parse(options || "{}") as { project?: string }).project ?? "";
  } catch {
    return "";
  }
}

export function DatabasesPage({ onOpen, onMonitor }: { onOpen: (c: DbConnection) => void; onMonitor: (c: DbConnection) => void }) {
  const hosts = useStore((s) => s.hosts);
  const [conns, setConns] = useState<DbConnection[]>([]);
  const [groups, setGroups] = useState<DbGroup[]>([]);
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const [formGroup, setFormGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  async function load() {
    try {
      const [c, g] = await Promise.all([api.getDbConnections(), api.getDbGroups()]);
      setConns(c);
      setGroups(g);
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
  }
  async function loadGroups() {
    setGroups(await api.getDbGroups());
  }
  useEffect(() => {
    void load();
  }, []);

  function toggleCollapsed(id: string) {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* bỏ qua */
    }
  }

  const searching = q.trim() !== "";
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return conns;
    return conns.filter((c) => [c.name, c.host, c.username, c.database ?? "", c.kind].some((v) => v.toLowerCase().includes(s)));
  }, [conns, q]);

  // Các phần: từng nhóm (kể cả nhóm rỗng khi không tìm kiếm) + "Ungrouped".
  const known = new Set(groups.map((g) => g.id));
  const sections = [
    ...groups.map((g) => ({ id: g.id, group: g as DbGroup | null, items: shown.filter((c) => c.group_id === g.id) })),
    { id: UNGROUPED, group: null as DbGroup | null, items: shown.filter((c) => !c.group_id || !known.has(c.group_id)) },
  ].filter((s) => (searching ? s.items.length > 0 : s.group !== null || s.items.length > 0));

  function newConnection(groupId: string | null) {
    setEditing(null);
    setFormGroup(groupId);
    setFormOpen(true);
  }

  async function newGroup() {
    const name = await promptDialog({ title: "New group", placeholder: "Group name (e.g. Production)", confirmText: "Create" });
    if (!name?.trim()) return;
    try {
      await api.upsertDbGroup(null, name.trim());
      await loadGroups();
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
  }

  async function renameGroup(g: DbGroup) {
    const name = await promptDialog({ title: "Rename group", initial: g.name, confirmText: "Rename" });
    if (!name?.trim() || name.trim() === g.name) return;
    try {
      await api.upsertDbGroup(g.id, name.trim());
      await loadGroups();
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
  }

  async function deleteGroup(g: DbGroup, count: number) {
    const msg = count
      ? `Delete group "${g.name}"? Its ${count} connection${count > 1 ? "s" : ""} will move to Ungrouped (they are not deleted).`
      : `Delete group "${g.name}"?`;
    if (!(await confirmDialog({ title: "Delete group", message: msg, confirmText: "Delete", danger: true }))) return;
    try {
      await api.deleteDbGroup(g.id);
      await load();
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
  }

  async function moveTo(connId: string, groupId: string | null) {
    const c = conns.find((x) => x.id === connId);
    if (!c || (c.group_id ?? null) === groupId) return;
    setConns((list) => list.map((x) => (x.id === connId ? { ...x, group_id: groupId } : x))); // phản hồi ngay
    try {
      await api.setDbConnectionGroup(connId, groupId);
    } catch (e) {
      alertDialog({ title: "Databases", message: String(e) });
    }
    void load();
  }

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

  function card(c: DbConnection) {
    const via = c.ssh_host_id ? hosts.find((h) => h.id === c.ssh_host_id) : null;
    const label = DB_KINDS.find((k) => k.id === c.kind)?.label ?? c.kind;
    return (
      <div
        key={c.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, c.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDropTarget(null)}
        onClick={() => onOpen(c)}
        className="group relative flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-accent"
      >
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in srgb, ${dbColor(c.kind)} 15%, transparent)` }}
          title={label}
        >
          <DbIcon kind={c.kind} className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate font-medium">
            <span className="truncate">{c.name}</span>
            {c.read_only && (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-500" title="Read-only">
                <Lock className="size-2.5" /> RO
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {label} ·{" "}
            {c.kind === "bigquery" ? (
              bqProject(c.options) || "(project from credentials)"
            ) : (
              <>
                {c.username ? `${c.username}@` : ""}
                {c.host}:{c.port}
              </>
            )}
            {c.database ? `/${c.database}` : ""}
          </div>
          {via ? (
            <div className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <Cable className="size-3" /> via {via.label}
            </div>
          ) : (
            c.ssh_host_id && (
              <div className="flex items-center gap-1 truncate text-[11px] text-destructive" title="Edit the connection and pick an SSH host again">
                <Cable className="size-3" /> SSH host missing
              </div>
            )
          )}
        </div>
        <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
          <IconBtn
            title="Monitor (live metrics, running queries)"
            onClick={(e) => {
              e.stopPropagation();
              onMonitor(c);
            }}
          >
            <Activity className="size-3.5" />
          </IconBtn>
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
  }

  const grid = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

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
        <Button size="sm" variant="outline" className="ml-auto" onClick={newGroup}>
          <FolderPlus className="size-4" /> Group
        </Button>
        <Button size="sm" onClick={() => newConnection(null)}>
          <Plus className="size-4" /> New connection
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {conns.length === 0 && groups.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Database className="size-10 opacity-40" />
            <p>No database connections yet.</p>
            <p className="max-w-md text-center text-xs">
              MySQL, MariaDB, PostgreSQL, ClickHouse, MongoDB, Redis and BigQuery — directly or through an SSH tunnel over any of your hosts.
            </p>
            <Button size="sm" onClick={() => newConnection(null)}>
              <Plus className="size-4" /> Add your first connection
            </Button>
          </div>
        ) : sections.length === 0 ? (
          <p className="mt-10 text-center text-muted-foreground">No connections match your search.</p>
        ) : groups.length === 0 ? (
          <div className={grid}>{shown.map(card)}</div>
        ) : (
          <div className="space-y-4">
            {sections.map((s) => {
              const open = searching || !collapsed[s.id];
              const target = s.group?.id ?? null;
              const isDrop = dropTarget === s.id;
              return (
                <section
                  key={s.id}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropTarget !== s.id) setDropTarget(s.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropTarget(null);
                    const id = e.dataTransfer.getData(DRAG_TYPE);
                    if (id) void moveTo(id, target);
                  }}
                  className={cn("rounded-xl border border-transparent p-1 transition-colors", isDrop && "border-primary/60 bg-primary/5")}
                >
                  <div className="group/h flex items-center gap-2 px-1 pb-2">
                    <button onClick={() => toggleCollapsed(s.id)} className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:text-primary">
                      <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                      {open ? <FolderOpen className="size-4 shrink-0 text-primary" /> : <Folder className="size-4 shrink-0 text-primary" />}
                      <span className="truncate">{s.group ? s.group.name : "Ungrouped"}</span>
                      <span className="text-xs font-normal text-muted-foreground">{s.items.length}</span>
                    </button>
                    {s.group && (
                      <div className="ml-1 hidden items-center gap-0.5 group-hover/h:flex">
                        <IconBtn title="New connection in this group" onClick={() => newConnection(s.group!.id)}>
                          <Plus className="size-3.5" />
                        </IconBtn>
                        <IconBtn title="Rename group" onClick={() => renameGroup(s.group!)}>
                          <Pencil className="size-3.5" />
                        </IconBtn>
                        <IconBtn title="Delete group" danger onClick={() => deleteGroup(s.group!, conns.filter((c) => c.group_id === s.group!.id).length)}>
                          <Trash2 className="size-3.5" />
                        </IconBtn>
                      </div>
                    )}
                    <div className="ml-2 h-px flex-1 bg-border" />
                  </div>
                  {open &&
                    (s.items.length ? (
                      <div className={grid}>{s.items.map(card)}</div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
                        Empty — drag a connection here, or{" "}
                        <button className="text-primary hover:underline" onClick={() => newConnection(target)}>
                          add one
                        </button>
                        .
                      </div>
                    ))}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <DbConnectionForm
        open={formOpen}
        conn={editing}
        groups={groups}
        defaultGroupId={formGroup}
        onGroupsChanged={loadGroups}
        onOpenChange={setFormOpen}
        onSaved={load}
      />
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
