import { useMemo, useState } from "react";
import { Key, Plus, FolderPlus, Cloud, Pencil, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { api, Host } from "../lib/ipc";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";

interface Props {
  onAdd: () => void;
  onEdit: (host: Host) => void;
  onKeys: () => void;
  onOpen: (host: Host) => void;
  onSync: () => void;
}

export function Sidebar({ onAdd, onEdit, onKeys, onOpen, onSync }: Props) {
  const groups = useStore((s) => s.groups);
  const hosts = useStore((s) => s.hosts);
  const refresh = useStore((s) => s.refresh);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const sections = useMemo(() => {
    const byGroup = new Map<string | null, Host[]>();
    for (const h of hosts) {
      const k = h.group_id;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(h);
    }
    const named = groups.map((g) => ({ id: g.id, name: g.name, hosts: byGroup.get(g.id) ?? [] }));
    return { named, ungrouped: byGroup.get(null) ?? [] };
  }, [groups, hosts]);

  function toggle(id: string) {
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function newGroup() {
    const name = prompt("New group name:");
    if (!name?.trim()) return;
    await api.createGroup(name.trim(), null);
    refresh();
  }
  async function delGroup(id: string, name: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete group "${name}"? (its hosts move to "no group")`)) return;
    await api.deleteGroup(id);
    refresh();
  }
  async function delHost(h: Host, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete host "${h.label}"?`)) return;
    await api.deleteHost(h.id);
    refresh();
  }

  const HostRow = (h: Host) => (
    <div
      key={h.id}
      onClick={() => onOpen(h)}
      className="group mb-1 flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 transition-colors hover:border-slate-600 hover:bg-accent"
    >
      <span className="size-2 shrink-0 rounded-full bg-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{h.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {h.username}@{h.address}
          {h.port !== 22 ? `:${h.port}` : ""}
        </div>
      </div>
      <div className="hidden gap-0.5 group-hover:flex">
        <button
          className="rounded p-1 text-muted-foreground hover:bg-border hover:text-foreground"
          title="Edit"
          onClick={(e) => { e.stopPropagation(); onEdit(h); }}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-border hover:text-destructive"
          title="Delete"
          onClick={(e) => delHost(h, e)}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <aside className="flex w-[270px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Hosts
        </span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon" className="size-8" onClick={newGroup} title="Create group">
            <FolderPlus className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" onClick={onKeys} title="Manage SSH keys">
            <Key className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" onClick={onSync} title="Cloud sync (GitHub)">
            <Cloud className="size-4" />
          </Button>
          <Button size="sm" onClick={onAdd} title="Add host">
            <Plus className="size-4" />
            Host
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {hosts.length === 0 && groups.length === 0 && (
          <div className="px-2 py-10 text-center leading-relaxed text-muted-foreground">
            No hosts yet.
            <br />
            Click “Host” to add one.
          </div>
        )}
        {sections.ungrouped.map(HostRow)}
        {sections.named.map((g) => {
          const isCollapsed = collapsed.has(g.id);
          return (
            <div key={g.id}>
              <div
                onClick={() => toggle(g.id)}
                className="group flex cursor-pointer items-center gap-2 px-2 pb-1 pt-3 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                <span className="flex-1 truncate">{g.name}</span>
                <span className="rounded-full bg-muted px-1.5 py-px text-[11px]">{g.hosts.length}</span>
                <button
                  className="hidden text-muted-foreground hover:text-destructive group-hover:inline"
                  title="Delete group"
                  onClick={(e) => delGroup(g.id, g.name, e)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              {!isCollapsed && g.hosts.map(HostRow)}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
