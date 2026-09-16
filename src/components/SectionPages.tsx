import { useEffect, useState } from "react";
import { Key, Copy, Trash2, Cloud, Settings as SettingsIcon, Fingerprint, Lock, ShieldCheck } from "lucide-react";
import { api } from "../lib/ipc";
import { confirmDialog, promptDialog, alertDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Keychain — quản lý SSH keys (dùng lại KeyManager dialog cho thao tác thêm/tạo/import). */
export function KeychainPage({ onManage }: { onManage: () => void }) {
  const keys = useStore((s) => s.keys);
  const refresh = useStore((s) => s.refresh);

  async function del(id: string, name: string) {
    if (!(await confirmDialog({ title: "Delete key", message: `Delete key "${name}"?`, confirmText: "Delete", danger: true }))) return;
    await api.deleteKey(id);
    refresh();
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">Keychain</h1>
        <span className="text-sm text-muted-foreground">SSH keys</span>
        <div className="ml-auto">
          <Button size="sm" onClick={onManage}>
            <Key className="size-4" /> Add / Generate key
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {keys.length === 0 ? (
          <Empty icon={Key} text="No SSH keys yet." action={<Button size="sm" onClick={onManage}><Key className="size-4" /> Add a key</Button>} />
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Fingerprint className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{k.name}</span>
                    <span className="rounded bg-muted px-1.5 py-px text-[11px] uppercase text-muted-foreground">{k.algorithm}</span>
                    {k.has_passphrase === 1 && <span className="text-[11px] text-muted-foreground">🔒 passphrase</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{k.fingerprint}</div>
                </div>
                <button
                  title="Copy public key"
                  onClick={() => navigator.clipboard?.writeText(k.public_key)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Copy className="size-4" />
                </button>
                <button
                  title="Delete"
                  onClick={() => del(k.id, k.name)}
                  className="rounded p-1.5 text-muted-foreground hover:text-destructive"
                >
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

/** Settings — cấu hình cloud sync + thông tin app (Phase 7 sẽ mở rộng). */
export function SettingsPage({ onSync }: { onSync: () => void }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <SettingsIcon className="size-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Settings</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-xl space-y-4">
          <AppLockCard />

          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Cloud className="size-5" />
            </span>
            <div className="flex-1">
              <div className="font-medium">Cloud Sync</div>
              <div className="text-sm text-muted-foreground">Back up your vault to a private GitHub repo (E2E encrypted).</div>
            </div>
            <Button size="sm" onClick={onSync}>Configure</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            More appearance & terminal settings are coming in a later phase.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Placeholder({
  icon: Icon, title, note,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  note: string;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">{title}</h1>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <Empty icon={Icon} text={note} />
      </div>
    </div>
  );
}

const TIMEOUTS = [
  { v: 0, l: "Off" },
  { v: 1, l: "1 min" },
  { v: 5, l: "5 min" },
  { v: 15, l: "15 min" },
  { v: 30, l: "30 min" },
];

/** Cấu hình khóa ứng dụng (mật khẩu mở tool + tự khóa). */
function AppLockCard() {
  const lockEnabled = useStore((s) => s.lockEnabled);
  const lockTimeout = useStore((s) => s.lockTimeout);
  const refreshLock = useStore((s) => s.refreshLock);
  const setLocked = useStore((s) => s.setLocked);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [idleMins, setIdleMins] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { refreshLock(); }, [refreshLock]);

  async function enable() {
    setErr(null);
    if (pw.length < 4) return setErr("Password too short (min 4 characters).");
    if (pw !== pw2) return setErr("Passwords don't match.");
    setBusy(true);
    try {
      await api.applockEnable(pw, idleMins);
      await refreshLock();
      setPw(""); setPw2("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    const cur = await promptDialog({
      title: "Disable app lock",
      message: "Enter your current app password to turn it off.",
      placeholder: "App password",
      confirmText: "Disable",
      danger: true,
    });
    if (cur == null) return;
    try {
      await api.applockDisable(cur);
      await refreshLock();
    } catch (e) {
      alertDialog({ title: "Error", message: String(e) });
    }
  }
  async function changeTimeout(v: number) {
    try {
      await api.applockSetTimeout(v);
      await refreshLock();
    } catch (e) {
      alertDialog({ title: "Error", message: String(e) });
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {lockEnabled ? <ShieldCheck className="size-5" /> : <Lock className="size-5" />}
        </span>
        <div className="flex-1">
          <div className="font-medium">App Lock</div>
          <div className="text-sm text-muted-foreground">
            {lockEnabled
              ? "A password is required to open Termez."
              : "Require a password to open Termez (protects against someone opening it on an unlocked machine)."}
          </div>
        </div>
        {lockEnabled && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Enabled</span>
        )}
      </div>

      {!lockEnabled ? (
        <div className="mt-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">App password</label>
              <Input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(null); }} placeholder="Password" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Confirm</label>
              <Input type="password" value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(null); }} placeholder="Repeat password" onKeyDown={(e) => { if (e.key === "Enter") enable(); }} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Auto-lock when idle</label>
            <TimeoutRow value={idleMins} onChange={setIdleMins} />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={enable} disabled={busy || !pw || !pw2}>Enable</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Auto-lock when idle</label>
            <TimeoutRow value={lockTimeout} onChange={changeTimeout} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocked(true)}>
              <Lock className="size-4" /> Lock now
            </Button>
            <Button variant="outline" size="sm" onClick={disable}>Disable</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TimeoutRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {TIMEOUTS.map((t) => (
        <button
          key={t.v}
          onClick={() => onChange(t.v)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition-colors",
            value === t.v
              ? "border-primary bg-primary/15 text-primary"
              : "border-border bg-background text-muted-foreground hover:border-slate-600 hover:text-foreground"
          )}
        >
          {t.l}
        </button>
      ))}
    </div>
  );
}

function Empty({
  icon: Icon, text, action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <Icon className="size-10 opacity-40" />
      <p className="text-sm">{text}</p>
      {action}
    </div>
  );
}
