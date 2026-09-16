import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, VaultEntry, VaultEntryInput } from "../lib/ipc";
import { generatePassword, strength } from "../lib/passwords";
import { useStore } from "../store";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  entry?: VaultEntry | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

const NONE = "__none__";
const BARS = ["bg-destructive", "bg-destructive", "bg-orange-500", "bg-yellow-500", "bg-primary"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function EntryForm({ open, entry, onOpenChange, onSaved }: Props) {
  const hosts = useStore((s) => s.hosts);
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [folder, setFolder] = useState("");
  const [totp, setTotp] = useState("");
  const [linked, setLinked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(entry?.title ?? "");
    setUsername(entry?.username ?? "");
    setPassword("");
    setUrl(entry?.url ?? "");
    setNotes(entry?.notes ?? "");
    setTags(entry?.tags ?? "");
    setFolder(entry?.folder ?? "");
    setTotp("");
    setLinked(entry?.linked_host_id ?? null);
    setError(null);
  }, [open, entry]);

  const st = strength(password);

  async function save() {
    if (!title.trim()) return setError("Title is required.");
    setSaving(true);
    setError(null);
    const input: VaultEntryInput = {
      id: entry?.id ?? null,
      title: title.trim(),
      username: username.trim() || null,
      url: url.trim() || null,
      notes: notes.trim() || null,
      tags: tags.trim() || null,
      folder: folder.trim() || null,
      linked_host_id: linked,
      password: password || null,
      totp_secret: totp.trim() || null,
    };
    try {
      await api.upsertEntry(input);
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
        <DialogHeader>
          <DialogTitle>{entry ? "Edit entry" : "New entry"}</DialogTitle>
        </DialogHeader>

        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="GitHub, AWS, …" />
        </Field>
        <Field label="Username / email">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field label="Password">
          <div className="flex gap-2">
            <Input
              type="text"
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={entry ? "(leave blank to keep current)" : ""}
            />
            <Button
              type="button"
              variant="outline"
              title="Generate a strong password"
              onClick={() =>
                setPassword(generatePassword({ length: 16, upper: true, lower: true, digits: true, symbols: true }))
              }
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {password && (
            <div className="flex items-center gap-2 pt-1">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full transition-all", BARS[st.score])} style={{ width: `${(st.score + 1) * 20}%` }} />
              </div>
              <span className="w-16 text-right text-[11px] text-muted-foreground">{st.label}</span>
            </div>
          )}
        </Field>

        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">Folder</label>
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Work" />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">Tags (comma-separated)</label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="db, prod" />
          </div>
        </div>

        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>

        <Field label="TOTP secret (base32, for 2FA codes)">
          <Input
            className="font-mono"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            placeholder={entry?.has_totp ? "(TOTP set — leave blank to keep)" : "JBSWY3DPEHPK3PXP"}
          />
        </Field>

        <Field label="Link to SSH host">
          <Select value={linked ?? NONE} onValueChange={(v) => setLinked(v === NONE ? null : v)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>(none)</SelectItem>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.label} ({h.username}@{h.address})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || !title.trim()}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
