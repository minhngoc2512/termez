import { useMemo, useState } from "react";
import { Server, Folder, Plus, Pencil, Trash2, Search, FolderPlus, FileDown, Activity } from "lucide-react";
import { api, Host } from "../lib/ipc";
import { confirmDialog, promptDialog, alertDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  onOpen: (h: Host) => void;
  onAdd: () => void;
  onEdit: (h: Host) => void;
  onMonitor: (h: Host) => void;
}

export function HostsPage({ onOpen, onAdd, onEdit, onMonitor }: Props) {
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const refresh = useStore((s) => s.refresh);
  const [filter, setFilter] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hosts) if (h.group_id) m.set(h.group_id, (m.get(h.group_id) || 0) + 1);
    return m;
  }, [hosts]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return hosts.filter(
      (h) =>
        (!filter || h.group_id === filter) &&
        (!s ||
          h.label.toLowerCase().includes(s) ||
          h.address.toLowerCase().includes(s) ||
          h.username.toLowerCase().includes(s))
    );
  }, [hosts, filter, q]);

  async function newGroup() {
    const name = await promptDialog({ title: "New group", placeholder: "Group name", confirmText: "Create" });
    if (!name?.trim()) return;
    await api.createGroup(name.trim(), null);
    refresh();
  }
  async function importConfig() {
    try {
      const msg = await api.importSshConfig();
      await refresh();
      alertDialog({ title: "Import ~/.ssh/config", message: msg });
    } catch (e) {
      alertDialog({ title: "Import failed", message: String(e) });
    }
  }
  async function del(h: Host, e: React.MouseEvent) {
    e.stopPropagation();
    if (!(await confirmDialog({ title: "Delete host", message: `Delete host "${h.label}"?`, confirmText: "Delete", danger: true }))) return;
    await api.deleteHost(h.id);
    refresh();
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">Hosts</h1>
        <div className="ml-3 flex flex-1 items-center gap-2 rounded-lg border border-input bg-card px-2.5 sm:max-w-sm">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, IP, user…"
            className="w-full bg-transparent py-1.5 text-sm outline-none"
          />
        </div>
        <Button variant="outline" size="sm" onClick={importConfig} title="Import hosts from ~/.ssh/config">
          <FileDown className="size-4" /> Import config
        </Button>
        <Button variant="outline" size="sm" onClick={newGroup}>
          <FolderPlus className="size-4" /> Group
        </Button>
        <Button size="sm" onClick={onAdd}>
          <Plus className="size-4" /> New host
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Group filter chips */}
        {groups.length > 0 && (
          <div className="mb-5 flex flex-wrap gap-2">
            <Chip active={filter === null} onClick={() => setFilter(null)}>
              All <span className="opacity-60">{hosts.length}</span>
            </Chip>
            {groups.map((g) => (
              <Chip key={g.id} active={filter === g.id} onClick={() => setFilter(filter === g.id ? null : g.id)}>
                <Folder className="size-3.5" /> {g.name}
                <span className="opacity-60">{counts.get(g.id) || 0}</span>
              </Chip>
            ))}
          </div>
        )}

        {shown.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Server className="size-10 opacity-40" />
            <p>{hosts.length === 0 ? "No hosts yet." : "No hosts match your search."}</p>
            {hosts.length === 0 && (
              <Button size="sm" onClick={onAdd}>
                <Plus className="size-4" /> Add your first host
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((h) => (
              <div
                key={h.id}
                onClick={() => onOpen(h)}
                className="group relative flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-accent"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Server className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{h.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {h.username}@{h.address}
                    {h.port !== 22 ? `:${h.port}` : ""}
                  </div>
                </div>
                <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                  <IconBtn title="Monitor (CPU/RAM/disk/net)" onClick={(e) => { e.stopPropagation(); onMonitor(h); }}>
                    <Activity className="size-3.5" />
                  </IconBtn>
                  <IconBtn title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(h); }}>
                    <Pencil className="size-3.5" />
                  </IconBtn>
                  <IconBtn title="Delete" danger onClick={(e) => del(h, e)}>
                    <Trash2 className="size-3.5" />
                  </IconBtn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:border-slate-600 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function IconBtn({
  title, danger, onClick, children,
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
        "rounded bg-background/80 p-1 text-muted-foreground backdrop-blur hover:bg-border hover:text-foreground",
        danger && "hover:text-destructive"
      )}
    >
      {children}
    </button>
  );
}
