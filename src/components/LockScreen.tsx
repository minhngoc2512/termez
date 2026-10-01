import { useState } from "react";
import { Lock } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Logo } from "./Logo";
import { TitleBar } from "./TitleBar";
import { api } from "../lib/ipc";
import { useStore } from "../store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Màn khóa phủ TOÀN cửa sổ, ĐÈ LÊN giao diện chính — giao diện bên dưới vẫn
 * mount (phiên SSH, task, pane, trang đang mở… giữ nguyên), App đặt `inert` cho nó.
 * Là một Radix Dialog modal để xếp chồng đúng trên dialog đang mở dở (Radix chuyển
 * focus-trap sang lớp trên cùng) — không thể tắt bằng Esc/click ra ngoài.
 */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const totp = useStore((s) => s.lockTotp);
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  // Phần tử đang focus lúc khóa (vd. terminal) — đọc khi render lần đầu, trước khi
  // App đặt `inert` làm mất focus; mở khóa xong trả focus về đó để gõ tiếp ngay.
  const [prevFocus] = useState(() => document.activeElement as HTMLElement | null);

  async function submit() {
    if (!pw || busy || (totp && code.length < 6)) return;
    setBusy(true);
    setErr(false);
    try {
      if (await api.applockUnlock(pw, totp ? code : null)) {
        onUnlock();
        requestAnimationFrame(() => prevFocus?.focus());
      }
      else { setErr(true); setPw(""); setCode(""); }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="fixed inset-0 z-[200] flex flex-col bg-background text-foreground outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <TitleBar />
          <div className="flex flex-1 flex-col items-center justify-center bg-background">
            <div className="flex w-80 flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 shadow-lg">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Lock className="size-7" />
              </span>
              <div className="text-center">
                <DialogPrimitive.Title className="flex items-center justify-center gap-2 text-lg font-semibold">
                  <Logo className="size-5" />
                  Termez is locked
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  Enter your app password to unlock.
                </DialogPrimitive.Description>
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
