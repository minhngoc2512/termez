import { useEffect, useMemo, useState } from "react";
import {
  Plus, Search, KeyRound, Eye, EyeOff, Copy, Pencil, Trash2, Timer, Terminal, ExternalLink, Download,
} from "lucide-react";
import { api, VaultEntry } from "../lib/ipc";
import { ImportDialog } from "./ImportDialog";
import { copyClearing } from "../lib/passwords";
import { hostActions } from "../lib/hostActions";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EntryForm } from "./EntryForm";

function TotpBadge({ id }: { id: string }) {
  const [code, setCode] = useState("……");
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    let alive = true;
    async function fetchCode() {
      try {
        const r = await api.entryTotpCode(id);
        if (alive) {
          setCode(r.code);
          setRemaining(r.remaining);
        }
      } catch {
        /* no totp */
      }
    }
    fetchCode();
    const t = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          fetchCode();
          return 30;
        }
        return r - 1;
      });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  return (
    <button
      onClick={() => copyClearing(code)}
      className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono hover:border-slate-600"
      title="Copy code"
    >
      <Timer className="size-4 text-primary" />
      <span className="tracking-widest">{code}</span>
      <span className="text-xs text-muted-foreground">{remaining}s</span>
    </button>
  );
}

export function VaultView() {
  const entries = useStore((s) => s.entries);
  const hosts = useStore((s) => s.hosts);
  const refresh = useStore((s) => s.refresh);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [pw, setPw] = useState<string | null>(null); // revealed password
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VaultEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const sel = entries.find((e) => e.id === selId) ?? null;

  useEffect(() => {
    setPw(null); // ẩn lại password khi đổi entry
  }, [selId]);

  const grouped = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = entries.filter(
      (e) =>
        !s ||
        e.title.toLowerCase().includes(s) ||
        (e.username ?? "").toLowerCase().includes(s) ||
        (e.url ?? "").toLowerCase().includes(s) ||
        (e.tags ?? "").toLowerCase().includes(s)
    );
    const map = new Map<string, VaultEntry[]>();
    for (const e of list) {
      const k = e.folder || "Ungrouped";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries, q]);

  async function reveal() {
    if (!sel) return;
    if (pw !== null) {
      setPw(null);
      return;
    }
    setPw(await api.entryPassword(sel.id).catch(() => ""));
  }
  async function del(en: VaultEntry) {
    if (!confirm(`Delete entry "${en.title}"?`)) return;
    await api.deleteEntry(en.id);
    if (selId === en.id) setSelId(null);
    refresh();
  }
  const linkedHost = sel?.linked_host_id ? hosts.find((h) => h.id === sel.linked_host_id) : null;

  return (
    <div className="flex h-full bg-background">
      {/* List */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1.5 border-b border-border p-2">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5">
            <Search className="size-4 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </div>
          <Button size="icon" className="size-8" onClick={() => { setEditing(null); setFormOpen(true); }} title="New entry">
            <Plus className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" onClick={() => setImportOpen(true)} title="Import from KeePass (.kdbx)">
            <Download className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {entries.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No entries yet.</div>
          )}
          {grouped.map(([folder, list]) => (
            <div key={folder} className="mb-2">
              <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wider text-muted-foreground">{folder}</div>
              {list.map((en) => (
                <button
                  key={en.id}
                  onClick={() => setSelId(en.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    selId === en.id ? "bg-accent" : "hover:bg-accent"
                  )}
                >
                  <KeyRound className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate text-sm">{en.title}</div>
                    {en.username && <div className="truncate text-xs text-muted-foreground">{en.username}</div>}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {!sel ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select an entry, or create one.
          </div>
        ) : (
          <div className="mx-auto max-w-xl space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <KeyRound className="size-5" />
                </span>
                <div>
                  <h1 className="text-lg font-semibold">{sel.title}</h1>
                  {sel.folder && <p className="text-xs text-muted-foreground">{sel.folder}</p>}
                </div>
              </div>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => { setEditing(sel); setFormOpen(true); }}>
                  <Pencil className="size-4" /> Edit
                </Button>
                <Button variant="outline" size="icon" className="size-9" onClick={() => del(sel)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            {sel.username && (
              <Row label="Username">
                <span className="font-mono">{sel.username}</span>
                <IconBtn title="Copy" onClick={() => copyClearing(sel.username!)}><Copy className="size-4" /></IconBtn>
              </Row>
            )}

            <Row label="Password">
              <span className="flex-1 font-mono">{pw === null ? "••••••••••••" : pw || "(empty)"}</span>
              <IconBtn title={pw === null ? "Reveal" : "Hide"} onClick={reveal}>
                {pw === null ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </IconBtn>
              <IconBtn
                title="Copy (auto-clears in 20s)"
                onClick={async () => copyClearing(pw ?? (await api.entryPassword(sel.id)))}
              >
                <Copy className="size-4" />
              </IconBtn>
            </Row>

            {sel.has_totp === 1 && (
              <Row label="2FA code"><TotpBadge id={sel.id} /></Row>
            )}

            {sel.url && (
              <Row label="URL">
                <span className="flex-1 truncate">{sel.url}</span>
                <IconBtn title="Copy" onClick={() => copyClearing(sel.url!)}><Copy className="size-4" /></IconBtn>
                <IconBtn title="Copy link"><ExternalLink className="size-4" /></IconBtn>
              </Row>
            )}

            {sel.tags && (
              <Row label="Tags">
                <div className="flex flex-wrap gap-1">
                  {sel.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                    <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs">{t}</span>
                  ))}
                </div>
              </Row>
            )}

            {linkedHost && (
              <Row label="Linked host">
                <span className="flex-1 truncate">{linkedHost.label} ({linkedHost.username}@{linkedHost.address})</span>
                <Button size="sm" onClick={() => hostActions.open(linkedHost)}>
                  <Terminal className="size-4" /> Open SSH
                </Button>
              </Row>
            )}

            {sel.notes && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Notes</div>
                <div className="whitespace-pre-wrap rounded-lg border border-border bg-card p-3 text-sm">{sel.notes}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <EntryForm open={formOpen} entry={editing} onOpenChange={setFormOpen} onSaved={refresh} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={refresh} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">{children}</div>
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
      {children}
    </button>
  );
}
