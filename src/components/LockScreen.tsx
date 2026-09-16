import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../lib/ipc";
import { useStore } from "../store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const totp = useStore((s) => s.lockTotp);
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pw || busy || (totp && code.length < 6)) return;
    setBusy(true);
    setErr(false);
    try {
      if (await api.applockUnlock(pw, totp ? code : null)) onUnlock();
      else { setErr(true); setPw(""); setCode(""); }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      <div className="flex w-80 flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 shadow-lg">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Lock className="size-7" />
        </span>
        <div className="text-center">
          <div className="text-lg font-semibold">⌘ Termez is locked</div>
          <div className="text-sm text-muted-foreground">Enter your app password to unlock.</div>
        </div>
        <Input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => { setPw(e.target.value); setErr(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="App password"
          className={cn(err && "border-destructive")}
        />
        {totp && (
          <Input
            inputMode="numeric"
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="6-digit 2FA code"
            className={cn("text-center font-mono tracking-widest", err && "border-destructive")}
          />
        )}
        {err && <div className="text-sm text-destructive">Wrong password{totp ? " or 2FA code" : ""}.</div>}
        <Button className="w-full" onClick={submit} disabled={busy || !pw || (totp && code.length < 6)}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
