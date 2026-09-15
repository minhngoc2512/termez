import { useMemo, useState } from "react";
import { Server, Folder, Plus, X } from "lucide-react";
import { Host } from "../lib/ipc";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  onOpen: (h: Host) => void;
  onAdd: () => void;
}

export function HomeView({ onOpen, onAdd }: Props) {
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const [filter, setFilter] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hosts) if (h.group_id) m.set(h.group_id, (m.get(h.group_id) || 0) + 1);
    return m;
  }, [hosts]);

  const shown = useMemo(
    () => (filter ? hosts.filter((h) => h.group_id === filter) : hosts),
    [hosts, filter]
  );

  return (
    <div className="h-full overflow-y-auto bg-background p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">⌘ Termez</h1>
          <p className="text-sm text-muted-foreground">Choose a host to open a terminal.</p>
        </div>
        <Button size="sm" onClick={onAdd}>
          <Plus className="size-4" />
          Host
        </Button>
      </div>

      {groups.length > 0 && (
        <section className="mb-7">
          <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Groups
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setFilter(filter === g.id ? null : g.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-slate-600 hover:bg-accent",
                  filter === g.id && "border-primary bg-accent"
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Folder className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium">{g.name}</div>
                  <div className="text-xs text-muted-foreground">{counts.get(g.id) || 0} hosts</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Hosts
          </h2>
          {filter && (
            <button
              onClick={() => setFilter(null)}
              className="flex items-center gap-0.5 text-xs text-primary hover:underline"
            >
              <X className="size-3" /> clear group filter
            </button>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
            No hosts yet. Click “Host” to add one.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {shown.map((h) => (
              <button
                key={h.id}
                onClick={() => onOpen(h)}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-slate-600 hover:bg-accent"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Server className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium">{h.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {h.auth_type === "key" ? "ssh · key" : "ssh"}, {h.username}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
