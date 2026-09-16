import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CloudOff, Loader2 } from "lucide-react";
import { api } from "../lib/ipc";
import { alertDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function SyncConflictDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"local" | "remote" | null>(null);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = listen("sync:conflict", () => setOpen(true));
    } catch { /* ngoài Tauri */ }
    return () => { un?.then((f) => f()).catch(() => {}); };
  }, []);

  async function resolve(choice: "local" | "remote") {
    setBusy(choice);
    try {
      await api.syncResolveConflict(choice);
      if (choice === "remote") await refresh();
      setOpen(false);
    } catch (e) {
      alertDialog({ title: "Sync conflict", message: String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudOff className="size-5 text-orange-500" /> Sync conflict
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The cloud vault changed on another device while this device also has local changes.
          Choose which version to keep — the other one will be overwritten.
        </p>
        <DialogFooter className="!flex-col gap-2 sm:items-stretch">
          <Button disabled={busy !== null} onClick={() => resolve("local")}>
            {busy === "local" ? <Loader2 className="size-4 animate-spin" /> : null}
            Keep this device's data (push, overwrite cloud)
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => resolve("remote")}>
            {busy === "remote" ? <Loader2 className="size-4 animate-spin" /> : null}
            Use cloud data (pull, discard local changes)
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setOpen(false)}>Decide later</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
