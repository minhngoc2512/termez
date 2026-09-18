import { useEffect, useState } from "react";
import {
  Key, Copy, Trash2, Cloud, Settings as SettingsIcon, Fingerprint, Lock, ShieldCheck,
  Sun, Moon, Monitor, Palette, SquareTerminal, Info, Download, RefreshCw,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/ipc";
import { confirmDialog, promptDialog, alertDialog } from "../lib/dialogs";
import { copyText } from "../lib/clipboard";
import { AppTheme, useStore } from "../store";
import { TERM_THEMES } from "../lib/themes";
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
                  onClick={() => copyText(k.public_key)}
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
          <AppearanceCard />
          <TerminalCard />
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

          <AboutCard />
        </div>
      </div>
    </div>
  );
}

type UpdateState = { current: string; latest: string; has_update: boolean; url: string; notes: string };

/** Thông tin app + phiên bản + kiểm tra cập nhật từ GitHub Releases. */
function AboutCard() {
  const autoUpdate = useStore((s) => s.autoUpdate);
  const setAutoUpdate = useStore((s) => s.setAutoUpdate);
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => { api.appVersion().then(setVersion).catch(() => {}); }, []);

  async function check() {
    setChecking(true);
    setErr(null);
    setUpd(null);
    try {
      setUpd(await api.checkUpdate());
    } catch (e) {
      setErr(String(e));
    } finally {
      setChecking(false);
    }
  }
  async function update() {
    setUpdating(true);
    try {
      await api.updateApply();
      await api.appRelaunch();
    } catch (e) {
      alertDialog({ title: "Update failed", message: String(e) });
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Info className="size-5" />
        </span>
        <div className="flex-1">
          <div className="font-medium">About Termez</div>
          <div className="text-sm text-muted-foreground">
            SSH / SFTP manager · version <span className="font-mono">{version || "…"}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={check} disabled={checking}>
          <RefreshCw className={cn("size-4", checking && "animate-spin")} />
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </div>

      {/* Bật/tắt tự động kiểm tra & nhắc cập nhật */}
      <label className="mt-3 flex cursor-pointer items-center gap-3 border-t border-border pt-3">
        <input
          type="checkbox"
          checked={autoUpdate}
          onChange={(e) => setAutoUpdate(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        <div className="flex-1">
          <div className="text-sm">Auto-check for updates</div>
          <div className="text-xs text-muted-foreground">Nhắc cập nhật khi mở app nếu có bản mới.</div>
        </div>
      </label>

      {err && <p className="mt-3 text-sm text-destructive">Couldn't check updates: {err}</p>}

      {upd && !err && (
        upd.has_update ? (
          <div className="mt-3 rounded-lg border border-primary/40 bg-primary/10 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Download className="size-4" />
              Update available — v{upd.latest}
            </div>
            {upd.notes && (
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {upd.notes.slice(0, 1200)}
              </pre>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => openUrl(upd.url).catch(() => {})}>
                Release page
              </Button>
              <Button size="sm" onClick={update} disabled={updating}>
                <Download className="size-4" /> {updating ? "Updating…" : "Update now"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">You're on the latest version.</p>
        )
      )}
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

function AppearanceCard() {
  const appTheme = useStore((s) => s.appTheme);
  const setAppTheme = useStore((s) => s.setAppTheme);
  const opts: { v: AppTheme; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { v: "light", label: "Light", icon: Sun },
    { v: "dark", label: "Dark", icon: Moon },
    { v: "system", label: "System", icon: Monitor },
  ];
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary"><Palette className="size-5" /></span>
        <div className="flex-1">
          <div className="font-medium">Appearance</div>
          <div className="text-sm text-muted-foreground">Light, dark, or follow the system theme.</div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {opts.map((o) => (
          <button key={o.v} onClick={() => setAppTheme(o.v)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
              appTheme === o.v ? "border-primary bg-primary/15 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"
            )}>
            <o.icon className="size-4" /> {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TerminalCard() {
  const termTheme = useStore((s) => s.termTheme);
  const setTermTheme = useStore((s) => s.setTermTheme);
  const termFontSize = useStore((s) => s.termFontSize);
  const setTermFontSize = useStore((s) => s.setTermFontSize);
  const shellReadyWait = useStore((s) => s.shellReadyWait);
  const setShellReadyWait = useStore((s) => s.setShellReadyWait);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary"><SquareTerminal className="size-5" /></span>
        <div className="flex-1">
          <div className="font-medium">Terminal</div>
          <div className="text-sm text-muted-foreground">Default color theme and font size for new terminals.</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Object.entries(TERM_THEMES).map(([key, def]) => (
          <button key={key} onClick={() => setTermTheme(key)}
            className={cn(
              "overflow-hidden rounded-lg border text-left transition-colors",
              termTheme === key ? "border-primary ring-1 ring-primary" : "border-border hover:border-slate-600"
            )}>
            <div className="px-2 py-1.5 font-mono text-[11px]" style={{ background: def.theme.background, color: def.theme.foreground }}>
              <span>user@host:~$</span>
              <span style={{ color: def.theme.cursor }}>▊</span>
            </div>
            <div className="bg-card px-2 py-1 text-xs">{def.label}</div>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <label className="text-sm text-muted-foreground">Font size</label>
        <input type="range" min={10} max={22} step={0.5} value={termFontSize}
          onChange={(e) => setTermFontSize(Number(e.target.value))} className="flex-1 accent-[var(--primary)]" />
        <span className="w-12 text-right text-sm tabular-nums">{termFontSize}px</span>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Applies to newly opened terminals. A host can still override this in its settings.</p>

      {/* Chờ shell sẵn sàng trước khi cho gõ (tránh "command not found" do PATH nạp trễ) */}
      <label className="mt-3 flex cursor-pointer items-center gap-3 border-t border-border pt-3">
        <input
          type="checkbox"
          checked={shellReadyWait}
          onChange={(e) => setShellReadyWait(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        <div className="flex-1">
          <div className="text-sm">Wait for shell to be ready</div>
          <div className="text-xs text-muted-foreground">
            Đệm phím tới khi shell nạp xong (im ~0.35s) rồi mới gửi — tránh lỗi "command not found" khi PATH nạp trễ (Powerlevel10k instant prompt, mise/asdf…).
          </div>
        </div>
      </label>
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
  const lockTotp = useStore((s) => s.lockTotp);
  const lockReauth = useStore((s) => s.lockReauth);
  const refreshLock = useStore((s) => s.refreshLock);
  const setLocked = useStore((s) => s.setLocked);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [idleMins, setIdleMins] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totpSetup, setTotpSetup] = useState(false);

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
  async function disableTotp() {
    const cur = await promptDialog({
      title: "Turn off 2FA",
      message: "Enter your app password to disable two-factor authentication.",
      placeholder: "App password",
      confirmText: "Turn off",
      danger: true,
    });
    if (cur == null) return;
    try {
      await api.applockTotpDisable(cur);
      await refreshLock();
    } catch (e) {
      alertDialog({ title: "Error", message: String(e) });
    }
  }
  async function changeReauth(v: number) {
    try {
      await api.applockSetReauth(v);
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
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Two-factor (2FA) can be turned on here once App Lock is enabled.
          </p>
          <div className="flex justify-end">
            <Button size="sm" onClick={enable} disabled={busy || !pw || !pw2}>Enable</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">Auto-lock when idle</label>
            <TimeoutRow value={lockTimeout} onChange={changeTimeout} />
          </div>

          {/* Two-factor (TOTP) */}
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <ShieldCheck className="size-4" />
              </span>
              <div className="flex-1">
                <div className="text-sm font-medium">Two-factor (2FA)</div>
                <div className="text-xs text-muted-foreground">
                  {lockTotp
                    ? "A 6-digit code from your authenticator app is required to unlock."
                    : "Add a one-time code from an authenticator app (Google Authenticator, Aegis…)."}
                </div>
              </div>
              {lockTotp ? (
                <Button variant="outline" size="sm" onClick={disableTotp}>Turn off</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setTotpSetup(true)}>Enable 2FA</Button>
              )}
            </div>

            {lockTotp && (
              <div className="mt-3 border-t border-border pt-3">
                <label className="text-xs text-muted-foreground">Require re-authentication every</label>
                <ReauthRow value={lockReauth} onChange={changeReauth} />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocked(true)}>
              <Lock className="size-4" /> Lock now
            </Button>
            <Button variant="outline" size="sm" onClick={disable}>Disable</Button>
          </div>
        </div>
      )}

      {totpSetup && (
        <TotpSetupDialog
          onClose={() => setTotpSetup(false)}
          onDone={async () => { setTotpSetup(false); await refreshLock(); }}
        />
      )}
    </div>
  );
}

const REAUTHS = [
  { v: 0, l: "Off" },
  { v: 15, l: "15 min" },
  { v: 60, l: "1 hour" },
  { v: 240, l: "4 hours" },
  { v: 480, l: "8 hours" },
];

function ReauthRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {REAUTHS.map((t) => (
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

/** Hộp thoại bật 2FA: hiện QR + secret, xác nhận bằng mã 6 số từ authenticator. */
function TotpSetupDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr_svg: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.applockTotpSetup()
      .then(setSetup)
      .catch((e) => setErr(String(e)));
  }, []);

  async function confirm() {
    if (!setup || code.length < 6 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.applockTotpEnable(setup.secret, code);
      onDone();
    } catch {
      setErr("Wrong code — check the time on your device and try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">Set up two-factor</div>
        <div className="mt-1 text-sm text-muted-foreground">
          Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.
        </div>

        {!setup ? (
          <div className="mt-6 text-center text-sm text-muted-foreground">
            {err ?? "Generating secret…"}
          </div>
        ) : (
          <>
            <div
              className="mx-auto mt-4 flex size-48 items-center justify-center rounded-lg bg-white p-2 [&>svg]:size-full"
              dangerouslySetInnerHTML={{ __html: setup.qr_svg }}
            />
            <div className="mt-3">
              <div className="text-xs text-muted-foreground">Or enter this key manually:</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{setup.secret}</code>
                <button
                  title="Copy key"
                  onClick={() => copyText(setup.secret)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Copy className="size-4" />
                </button>
              </div>
            </div>
            <Input
              className={cn("mt-4 text-center font-mono tracking-widest", err && "border-destructive")}
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
              placeholder="6-digit code"
            />
            {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={confirm} disabled={!setup || code.length < 6 || busy}>
            {busy ? "Verifying…" : "Enable 2FA"}
          </Button>
        </div>
      </div>
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
