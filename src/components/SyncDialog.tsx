import { useEffect, useState } from "react";
import { CloudUpload, CloudDownload, Save, Loader2, History, ChevronRight, ShieldAlert, RotateCcw } from "lucide-react";
import { api, VaultSummary, VaultVersion } from "../lib/ipc";
import { confirmDialog } from "../lib/dialogs";
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
  const [busy, setBusy] = useState<null | "save" | "push" | "pull" | "restore">(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<VaultVersion[] | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ commit: string; summary?: VaultSummary; err?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setMaster("");
    setPat("");
    setShowHistory(false);
    setVersions(null);
    setPreview(null);
    api.syncGetConfig()
      .then((c) => {
        setRepo(c.repo ?? "");
        setHasPat(c.has_pat);
        setAuto(c.auto);
        setDisabled(c.disabled);
        setPaused(c.paused);
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
      try {
        setMsg({ text: await api.syncPush(master) });
      } catch (e) {
        // Chốt chặn: lần đẩy này sẽ xoá hàng loạt dữ liệu trên cloud → hỏi rõ.
        const g = String(e).match(/SYNC_GUARD\|(push|pull)\|(.*)/);
        if (!g) throw e;
        const ok = await confirmDialog({
          title: "Backup would delete data in the cloud",
          message: `${g[2]}\n\nOverwrite the cloud vault anyway? Older versions stay in the repo history.`,
          confirmText: "Overwrite cloud",
          danger: true,
        });
        if (!ok) return setMsg({ text: "Backup cancelled." });
        setMsg({ text: await api.syncPush(master, true) });
      }
      setPaused(false);
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  async function pull() {
    if (!master) return setMsg({ text: "Enter your master password.", err: true });
    if (!(await confirmDialog({
      title: "Restore from cloud",
      message:
        "Restore replaces this device's hosts, keys, tunnels, vault and storage connections with the latest cloud vault. A backup of the current data is saved first. Continue?",
      confirmText: "Restore",
      danger: true,
    })))
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

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (!next || versions) return;
    setHistoryErr(null);
    try {
      setVersions(await api.syncHistory());
    } catch (e) {
      setHistoryErr(String(e));
    }
  }

  async function previewVersion(commit: string) {
    if (preview?.commit === commit) return setPreview(null);
    setPreview({ commit });
    try {
      setPreview({ commit, summary: await api.syncPreviewVersion(commit, master || null) });
    } catch (e) {
      setPreview({ commit, err: String(e) });
    }
  }

  async function restoreVersion(v: VaultVersion) {
    const when = new Date(v.date).toLocaleString();
    if (
      !(await confirmDialog({
        title: "Restore this version?",
        message: `Replace this device's data with the vault from ${when} (${v.commit.slice(0, 8)}) and push it as the new cloud version. A backup of the current data is saved first; the repo history keeps every version.`,
        confirmText: "Restore",
        danger: true,
      }))
    )
      return;
    setBusy("restore");
    setMsg(null);
    try {
      const r = await api.syncRestoreVersion(v.commit, master || null);
      await refresh();
      setMsg({ text: r });
      setPaused(false);
      setVersions(await api.syncHistory().catch(() => versions));
      setPreview(null);
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cloud sync (GitHub)</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          End-to-end encrypted: data is encrypted with your master password before it leaves this
          device — GitHub only stores ciphertext. If you forget the master password, the backup
          cannot be recovered.
        </p>

        {disabled && (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            Cloud sync is disabled for this instance (<code>TERMEZ_NO_SYNC=1</code>).
          </div>
        )}
        {paused && !disabled && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            Auto-sync is paused: a sync would have deleted a large part of your data. Back up this device, restore from
            the cloud, or pick a version below to resume.
          </div>
        )}

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

        {/* Lịch sử phiên bản: mỗi lần backup là một commit trong repo */}
        <div className="rounded-md border border-border">
          <button
            type="button"
            onClick={toggleHistory}
            disabled={disabled}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 disabled:opacity-50"
          >
            <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", showHistory && "rotate-90")} />
            <History className="size-4 text-muted-foreground" /> Version history
            <span className="ml-auto text-xs text-muted-foreground">restore an older backup</span>
          </button>
          {showHistory && (
            <div className="max-h-72 overflow-y-auto border-t border-border">
              {historyErr ? (
                <p className="selectable px-3 py-2 text-xs text-destructive">{historyErr}</p>
              ) : !versions ? (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </p>
              ) : versions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No backups yet.</p>
              ) : (
                versions.map((v, i) => (
                  <div key={v.commit} className="border-b border-border/60 last:border-0">
                    <button
                      type="button"
                      onClick={() => previewVersion(v.commit)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50"
                    >
                      <span className="font-mono text-muted-foreground">{v.commit.slice(0, 8)}</span>
                      <span>{new Date(v.date).toLocaleString()}</span>
                      {i === 0 && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">current</span>}
                      <span className="ml-auto truncate text-muted-foreground">{v.message}</span>
                    </button>
                    {preview?.commit === v.commit && (
                      <div className="bg-card/60 px-3 pb-2 text-xs">
                        {preview.err ? (
                          <p className="selectable text-destructive">{preview.err}</p>
                        ) : !preview.summary ? (
                          <p className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" /> Decrypting…
                          </p>
                        ) : (
                          <>
                            <p className="text-muted-foreground">
                              {preview.summary.hosts} hosts · {preview.summary.keys} keys · {preview.summary.tunnels} tunnels ·{" "}
                              {preview.summary.entries} vault entries · {preview.summary.buckets} storage ·{" "}
                              {preview.summary.secrets} secrets
                            </p>
                            {preview.summary.host_labels.length > 0 && (
                              <p className="mt-0.5 truncate" title={preview.summary.host_labels.join(", ")}>
                                Hosts: {preview.summary.host_labels.join(", ")}
                              </p>
                            )}
                            {i > 0 && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-7"
                                disabled={busy !== null}
                                onClick={() => restoreVersion(v)}
                              >
                                {busy === "restore" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                                Restore this version
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {msg && (
          <p className={cn("selectable text-sm", msg.err ? "text-destructive" : "text-primary")}>{msg.text}</p>
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
