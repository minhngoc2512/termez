import { useEffect, useState } from "react";
import { CloudUpload, CloudDownload, Save, Loader2 } from "lucide-react";
import { api } from "../lib/ipc";
import { useStore } from "../store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function SyncDialog({ open, onOpenChange }: Props) {
  const refresh = useStore((s) => s.refresh);
  const [repo, setRepo] = useState("");
  const [pat, setPat] = useState("");
  const [hasPat, setHasPat] = useState(false);
  const [master, setMaster] = useState("");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "push" | "pull">(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setMaster("");
    setPat("");
    api.syncGetConfig()
      .then((c) => {
        setRepo(c.repo ?? "");
        setHasPat(c.has_pat);
        setAuto(c.auto);
      })
      .catch(() => {});
  }, [open]);

  async function toggleAuto(on: boolean) {
    try {
      await api.syncSaveConfig(pat || null, repo.trim());
      await api.syncSetAuto(on, on ? master : null);
      setAuto(on);
      setMsg({ text: on ? "Auto-sync enabled — backs up on every change." : "Auto-sync disabled." });
    } catch (err) {
      setMsg({ text: String(err), err: true });
    }
  }

  async function saveCfg() {
    setBusy("save");
    setMsg(null);
    try {
      await api.syncSaveConfig(pat || null, repo.trim());
      setHasPat(hasPat || !!pat);
      setPat("");
      setMsg({ text: "Config saved." });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    if (!master) return setMsg({ text: "Enter your master password.", err: true });
    setBusy("push");
    setMsg(null);
    try {
      await api.syncSaveConfig(pat || null, repo.trim());
      setMsg({ text: await api.syncPush(master) });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  async function pull() {
    if (!master) return setMsg({ text: "Enter your master password.", err: true });
    if (!confirm("Restore overwrites your local hosts/keys/tunnels with the cloud vault. Continue?"))
      return;
    setBusy("pull");
    setMsg(null);
    try {
      await api.syncSaveConfig(pat || null, repo.trim());
      const r = await api.syncPull(master);
      await refresh();
      setMsg({ text: r });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cloud sync (GitHub)</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          End-to-end encrypted: data is encrypted with your master password before it leaves this
          device — GitHub only stores ciphertext. If you forget the master password, the backup
          cannot be recovered.
        </p>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Private repo (owner/repo)</label>
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="yourname/termez-vault" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            GitHub token — fine-grained PAT, Contents: read &amp; write
          </label>
          <Input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder={hasPat ? "•••• saved — leave blank to keep" : "ghp_…"}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Master password — encryption key, never uploaded
          </label>
          <Input
            type="password"
            value={master}
            onChange={(e) => setMaster(e.target.value)}
            placeholder="your secret passphrase"
          />
        </div>

        <label className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
          <Checkbox checked={auto} onCheckedChange={(c) => toggleAuto(c === true)} />
          <span>
            Auto-sync — back up on every change
            <span className="block text-xs text-muted-foreground">
              Stores the master password in the OS keychain to encrypt silently.
            </span>
          </span>
        </label>

        {msg && (
          <p className={cn("text-sm", msg.err ? "text-destructive" : "text-primary")}>{msg.text}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button variant="outline" onClick={saveCfg} disabled={busy !== null}>
            <Save className="size-4" />
            Save config
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={pull} disabled={busy !== null}>
              {busy === "pull" ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
              Restore
            </Button>
            <Button onClick={push} disabled={busy !== null}>
              {busy === "push" ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
              Backup
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
