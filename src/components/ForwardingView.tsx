import { useEffect, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Plus, Play, Square, Pencil, Trash2 } from "lucide-react";
import { api, Tunnel, TunnelStatus } from "../lib/ipc";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TunnelForm } from "./TunnelForm";

export function ForwardingView() {
  const tunnels = useStore((s) => s.tunnels);
  const hosts = useStore((s) => s.hosts);
  const refresh = useStore((s) => s.refresh);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Tunnel | null>(null);

  useEffect(() => {
    api.tunnelActive().then((ids) => setActive(new Set(ids))).catch(() => {});
    let un: UnlistenFn | undefined;
    listen<TunnelStatus>("tunnel:status", (e) => {
      const { id, active: a, error } = e.payload;
      setActive((prev) => {
        const n = new Set(prev);
        if (a) n.add(id);
        else n.delete(id);
        return n;
      });
      setErrors((prev) => {
        const n = { ...prev };
        if (error) n[id] = error;
        else delete n[id];
        return n;
      });
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  async function toggle(t: Tunnel) {
    try {
      if (active.has(t.id)) await api.tunnelStop(t.id);
      else await api.tunnelStart(t.id);
    } catch (err) {
      setErrors((p) => ({ ...p, [t.id]: String(err) }));
    }
  }
  async function del(t: Tunnel) {
    if (!confirm(`Delete tunnel "${t.name}"?`)) return;
    await api.deleteTunnel(t.id);
    refresh();
  }
  const hostLabel = (id: string) => hosts.find((h) => h.id === id)?.label ?? "?";

  return (
    <div className="h-full overflow-y-auto bg-background p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Port Forwarding</h2>
        <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="size-4" />
          New tunnel
        </Button>
      </div>

      {tunnels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          No tunnels yet. Click “New tunnel” to add one.
        </div>
      ) : (
        <div className="space-y-2">
          {tunnels.map((t) => {
            const on = active.has(t.id);
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                <span className={cn("size-2 shrink-0 rounded-full", on ? "bg-primary" : "bg-muted-foreground/40")} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {t.name}
                    <span className="ml-2 rounded bg-muted px-1.5 py-px text-[11px] uppercase text-muted-foreground">
                      {t.kind}
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {t.kind === "dynamic"
                      ? `socks5://localhost:${t.local_port}`
                      : `localhost:${t.local_port} → ${t.remote_host}:${t.remote_port}`}
                    {"  ·  via "}
                    {hostLabel(t.host_id)}
                  </div>
                  {errors[t.id] && <div className="text-xs text-destructive">{errors[t.id]}</div>}
                </div>
                <Button size="sm" variant={on ? "destructive" : "default"} onClick={() => toggle(t)}>
                  {on ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  {on ? "Stop" : "Start"}
                </Button>
                <button
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => { setEditing(t); setFormOpen(true); }}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  className="rounded p-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => del(t)}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <TunnelForm open={formOpen} tunnel={editing} onOpenChange={setFormOpen} onSaved={refresh} />
    </div>
  );
}
