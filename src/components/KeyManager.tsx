import { useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import { api } from "../lib/ipc";
import { confirmDialog } from "../lib/dialogs";
import { useStore } from "../store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Mode = "list" | "generate" | "import";

export function KeyManager({ open, onOpenChange }: Props) {
  const keys = useStore((s) => s.keys);
  const refresh = useStore((s) => s.refresh);
  const [mode, setMode] = useState<Mode>("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState("ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  function reset() {
    setName("");
    setAlgorithm("ed25519");
    setPassphrase("");
    setPrivateKey("");
    setError(null);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      reset();
      setMode("list");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del(id: string, kname: string) {
    if (!(await confirmDialog({
      title: "Delete key",
      message: `Delete key "${kname}"? (its private key in the keychain is also removed)`,
      confirmText: "Delete",
      danger: true,
    }))) return;
    await api.deleteKey(id);
    refresh();
  }

  const tab = (m: Mode, txt: string) => (
    <button
      onClick={() => { reset(); setMode(m); }}
      className={cn(
        "rounded-md border border-border px-2.5 py-1.5 text-[13px]",
        mode === m ? "border-primary bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {txt}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle>SSH Keys</DialogTitle>
          <div className="flex gap-1">
            {tab("list", "List")}
            {tab("generate", "Generate")}
            {tab("import", "Import")}
          </div>
        </DialogHeader>

        {mode === "list" && (
          <div className="space-y-1.5">
            {keys.length === 0 && <p className="text-sm text-muted-foreground">No keys yet.</p>}
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2.5 rounded-lg border border-border p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {k.name} <span className="text-xs text-primary">{k.algorithm}</span>
                    {k.has_passphrase ? <Lock className="ml-1 inline size-3" /> : null}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{k.fingerprint}</div>
                </div>
                <button className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => del(k.id, k.name)}>
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === "generate" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Key name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-key" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Algorithm</label>
              <Select value={algorithm} onValueChange={setAlgorithm}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ed25519">Ed25519 (recommended)</SelectItem>
                  <SelectItem value="rsa">RSA 4096</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Passphrase (optional)</label>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="leave blank if not needed" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMode("list")}>Cancel</Button>
              <Button disabled={busy} onClick={() => run(() => api.generateKey(name.trim() || "key", algorithm, passphrase || null))}>
                {busy ? "Generating…" : "Generate key"}
              </Button>
            </div>
          </div>
        )}

        {mode === "import" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Key name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="imported-key" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Private key (paste OpenSSH/PEM content)</label>
              <Textarea className="font-mono" rows={7} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Passphrase (if any)</label>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMode("list")}>Cancel</Button>
              <Button disabled={busy || !privateKey} onClick={() => run(() => api.importKey(name.trim() || "imported", privateKey, passphrase || null))}>
                {busy ? "Importing…" : "Import key"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
