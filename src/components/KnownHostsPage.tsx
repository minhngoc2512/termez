import { useEffect, useState } from "react";
import { ShieldCheck, Trash2, RefreshCw, Search, Fingerprint } from "lucide-react";
import { api, KnownHost } from "../lib/ipc";
import { confirmDialog, alertDialog } from "../lib/dialogs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function KnownHostsPage() {
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  async function load() {
    setLoading(true);
    try {
      setHosts(await api.knownHostsList());
    } catch (e) {
      alertDialog({ title: "Known Hosts", message: String(e) });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function del(h: KnownHost) {
    if (!(await confirmDialog({
      title: "Forget host key",
      message: `Remove the saved key for ${h.host}:${h.port}? You'll be asked to trust it again on next connect.`,
      confirmText: "Forget",
      danger: true,
    }))) return;
    await api.knownHostsDelete(h.id);
    load();
  }

  const s = q.trim().toLowerCase();
  const shown = s
    ? hosts.filter((h) => h.host.toLowerCase().includes(s) || h.fingerprint.toLowerCase().includes(s) || h.key_type.toLowerCase().includes(s))
    : hosts;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <ShieldCheck className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Known Hosts</h1>
        {hosts.length > 0 && (
          <div className="ml-3 flex flex-1 items-center gap-2 rounded-lg border border-input bg-card px-2.5 sm:max-w-xs">
            <Search className="size-4 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search host, fingerprint…"
              className="w-full bg-transparent py-1.5 text-sm outline-none" />
          </div>
        )}
        <Button variant="outline" size="icon" className="ml-auto size-9" title="Refresh" onClick={load}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          SSH server keys you've trusted. On the first connection you're asked to verify the key; if a
          host's key ever changes you'll get a warning (possible man-in-the-middle). Remove an entry to
          be asked again.
        </p>
        {shown.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
            <ShieldCheck className="size-10 opacity-40" />
            <p>{hosts.length === 0 ? "No trusted host keys yet." : "No matches."}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {shown.map((h) => (
              <div key={h.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Fingerprint className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{h.host}:{h.port}</span>
                    <span className="rounded bg-muted px-1.5 py-px text-[11px] uppercase text-muted-foreground">{h.key_type}</span>
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{h.fingerprint}</div>
                </div>
                <button title="Forget" onClick={() => del(h)} className="rounded p-1.5 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
