import { useEffect, useState } from "react";
import {
  Globe, Loader2, Plus, Pencil, Trash2, RefreshCw, Settings, Cloud, CloudOff, Search, Copy, Check,
} from "lucide-react";
import { api, CfConfig, CfInput, CfRecord, CfZone } from "../lib/ipc";
import { confirmDialog, alertDialog } from "../lib/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const REC_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR"];
const PROXIABLE = new Set(["A", "AAAA", "CNAME"]);
const DEFAULT_URL = "https://api.cloudflare.com/client/v4";

export function CloudflareDnsPage() {
  const [config, setConfig] = useState<CfConfig | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const [zones, setZones] = useState<CfZone[]>([]);
  const [zoneId, setZoneId] = useState<string>("");
  const [records, setRecords] = useState<CfRecord[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CfRecord | null>(null);

  useEffect(() => {
    api.cfGetConfig().then((c) => {
      setConfig(c);
      if (!c.has_token) setShowConfig(true);
    }).catch(() => {
      setConfig({ api_url: DEFAULT_URL, account_id: "", has_token: false });
      setShowConfig(true);
    });
  }, []);

  useEffect(() => {
    if (config?.has_token && !showConfig) loadZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.has_token, showConfig]);

  useEffect(() => {
    if (zoneId) loadRecords(zoneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneId]);

  async function loadZones() {
    setLoading(true);
    try {
      const z = await api.cfListZones();
      setZones(z);
      if (z.length && !z.find((x) => x.id === zoneId)) setZoneId(z[0].id);
    } catch (e) {
      alertDialog({ title: "Cloudflare", message: String(e) });
    } finally {
      setLoading(false);
    }
  }
  async function loadRecords(zid: string) {
    setLoading(true);
    try {
      setRecords(await api.cfListRecords(zid));
    } catch (e) {
      alertDialog({ title: "Cloudflare", message: String(e) });
    } finally {
      setLoading(false);
    }
  }
  async function del(r: CfRecord) {
    if (!(await confirmDialog({ title: "Delete record", message: `Delete ${r.type} ${r.name}?`, confirmText: "Delete", danger: true }))) return;
    try {
      await api.cfDeleteRecord(zoneId, r.id);
      loadRecords(zoneId);
    } catch (e) {
      alertDialog({ title: "Cloudflare", message: String(e) });
    }
  }

  if (config && (showConfig || !config.has_token)) {
    return <ConfigForm config={config} onDone={(c) => { setConfig(c); setShowConfig(false); }} onCancel={config.has_token ? () => setShowConfig(false) : undefined} />;
  }

  const zoneName = zones.find((z) => z.id === zoneId)?.name ?? "";
  const s = q.trim().toLowerCase();
  const shown = !s
    ? records
    : records.filter(
        (r) =>
          r.name.toLowerCase().includes(s) ||
          r.content.toLowerCase().includes(s) ||
          r.type.toLowerCase().includes(s)
      );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Globe className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Cloudflare DNS</h1>
        {config?.has_token && (
          <div className="ml-3 w-52">
            <Select value={zoneId} onValueChange={setZoneId}>
              <SelectTrigger><SelectValue placeholder="Select a domain…" /></SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {config?.has_token && zoneId && (
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-card px-2.5 sm:max-w-xs">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, IP, type…"
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="icon" className="size-9" title="Refresh" onClick={() => zoneId ? loadRecords(zoneId) : loadZones()}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button variant="outline" size="icon" className="size-9" title="Settings" onClick={() => setShowConfig(true)}>
            <Settings className="size-4" />
          </Button>
          <Button size="sm" disabled={!zoneId} onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="size-4" /> Add record
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {zones.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No zones found for this token/account.
          </div>
        ) : shown.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {records.length === 0 ? `No DNS records in ${zoneName}.` : "No records match your search."}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-card text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <Th>Type</Th><Th>Name</Th><Th>Content</Th><Th>TTL</Th><Th>Proxy</Th><Th> </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="group border-b border-border/60 hover:bg-accent">
                  <Td><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r.type}</span></Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{r.name}</span>
                      <CopyBtn value={r.name} />
                    </span>
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs">{r.priority != null ? `${r.priority} ` : ""}{r.content}</span>
                      <CopyBtn value={r.content} />
                    </span>
                  </Td>
                  <Td muted>{r.ttl === 1 ? "Auto" : r.ttl}</Td>
                  <Td>
                    {r.proxiable ? (
                      r.proxied ? <Cloud className="size-4 text-orange-500" /> : <CloudOff className="size-4 text-muted-foreground" />
                    ) : <span className="text-muted-foreground">—</span>}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <IconBtn title="Edit" onClick={() => { setEditing(r); setFormOpen(true); }}><Pencil className="size-4" /></IconBtn>
                      <IconBtn title="Delete" danger onClick={() => del(r)}><Trash2 className="size-4" /></IconBtn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <RecordForm
        open={formOpen}
        zoneId={zoneId}
        zoneName={zoneName}
        record={editing}
        onOpenChange={setFormOpen}
        onSaved={() => loadRecords(zoneId)}
      />
    </div>
  );
}

function ConfigForm({ config, onDone, onCancel }: { config: CfConfig; onDone: (c: CfConfig) => void; onCancel?: () => void }) {
  const [apiUrl, setApiUrl] = useState(config.api_url || DEFAULT_URL);
  const [accountId, setAccountId] = useState(config.account_id || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.cfSaveConfig(apiUrl.trim() || DEFAULT_URL, accountId.trim(), token.trim() || null);
      await api.cfVerify();
      onDone(await api.cfGetConfig());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (!(await confirmDialog({ title: "Disconnect Cloudflare", message: "Remove the stored token, URL and account id?", confirmText: "Remove", danger: true }))) return;
    await api.cfClearConfig();
    onDone(await api.cfGetConfig());
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Globe className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Cloudflare DNS — Setup</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-lg space-y-4">
          <p className="text-sm text-muted-foreground">
            Create an API Token with <span className="font-mono text-foreground">Zone · DNS · Edit</span> permission in your
            Cloudflare dashboard, then paste it here. The token is stored in your OS keychain, never in plain text.
          </p>
          <Field label="API URL">
            <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder={DEFAULT_URL} className="font-mono text-xs" />
          </Field>
          <Field label="Account ID (optional — filters zones)">
            <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="e.g. 0123abcd…" className="font-mono text-xs" />
          </Field>
          <Field label={config.has_token ? "API Token (leave blank to keep current)" : "API Token"}>
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bearer token" className="font-mono text-xs" />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between">
            <div>
              {config.has_token && <Button variant="outline" size="sm" onClick={clear}>Disconnect</Button>}
            </div>
            <div className="flex gap-2">
              {onCancel && <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>}
              <Button size="sm" onClick={save} disabled={busy || (!config.has_token && !token.trim())}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Save & verify
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecordForm({
  open, zoneId, zoneName, record, onOpenChange, onSaved,
}: {
  open: boolean;
  zoneId: string;
  zoneName: string;
  record: CfRecord | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState("A");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [ttlAuto, setTtlAuto] = useState(true);
  const [ttl, setTtl] = useState(3600);
  const [proxied, setProxied] = useState(false);
  const [priority, setPriority] = useState(10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(record?.type ?? "A");
    setName(record?.name ?? "");
    setContent(record?.content ?? "");
    setTtlAuto((record?.ttl ?? 1) === 1);
    setTtl(record && record.ttl !== 1 ? record.ttl : 3600);
    setProxied(record?.proxied ?? false);
    setPriority(record?.priority ?? 10);
    setError(null);
  }, [open, record]);

  async function save() {
    if (!name.trim() || !content.trim()) return setError("Name and content are required.");
    setSaving(true); setError(null);
    const input: CfInput = {
      type,
      name: name.trim(),
      content: content.trim(),
      ttl: ttlAuto ? 1 : Math.max(60, ttl),
      proxied: PROXIABLE.has(type) ? proxied : false,
      priority: type === "MX" || type === "SRV" ? priority : null,
    };
    try {
      if (record) await api.cfUpdateRecord(zoneId, record.id, input);
      else await api.cfCreateRecord(zoneId, input);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{record ? "Edit DNS record" : "New DNS record"}</DialogTitle></DialogHeader>

        <div className="flex gap-3">
          <div className="w-28 space-y-1">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{REC_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={zoneName ? `sub.${zoneName} or @` : "@"} />
          </div>
        </div>

        <Field label={type === "TXT" ? "Content (text)" : type === "MX" ? "Mail server" : "Content"}>
          {type === "TXT" ? (
            <Textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} />
          ) : (
            <Input value={content} onChange={(e) => setContent(e.target.value)}
              placeholder={type === "A" ? "192.0.2.1" : type === "AAAA" ? "2606:…" : type === "CNAME" ? "target.example.com" : ""} />
          )}
        </Field>

        {(type === "MX" || type === "SRV") && (
          <Field label="Priority">
            <Input type="number" value={priority} onChange={(e) => setPriority(+e.target.value || 0)} />
          </Field>
        )}

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">TTL</label>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={ttlAuto} onCheckedChange={(v) => setTtlAuto(!!v)} /> Auto</label>
              {!ttlAuto && <Input type="number" value={ttl} onChange={(e) => setTtl(+e.target.value || 3600)} className="w-28" />}
            </div>
          </div>
          {PROXIABLE.has(type) && (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox checked={proxied} onCheckedChange={(v) => setProxied(!!v)} /> Proxied (orange cloud)
            </label>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      title="Copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      className={cn(
        "shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground",
        done ? "text-primary opacity-100" : "opacity-0 group-hover:opacity-100"
      )}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}
function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <td className={cn("max-w-0 px-3 py-2", muted && "text-muted-foreground")}><div className="truncate">{children}</div></td>;
}
function IconBtn({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className={cn("rounded p-1.5 text-muted-foreground hover:bg-border hover:text-foreground", danger && "hover:text-destructive")}>
      {children}
    </button>
  );
}
