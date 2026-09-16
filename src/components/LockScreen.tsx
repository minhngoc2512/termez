import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../lib/ipc";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pw || busy) return;
    setBusy(true);
    setErr(false);
    try {
      if (await api.applockVerify(pw)) onUnlock();
      else { setErr(true); setPw(""); }
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
        {err && <div className="text-sm text-destructive">Wrong password.</div>}
        <Button className="w-full" onClick={submit} disabled={busy || !pw}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
