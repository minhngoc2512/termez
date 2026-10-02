import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ShieldAlert, Loader2 } from "lucide-react";
import { api, SyncGuard } from "../lib/ipc";
import { alertDialog, confirmDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Cloud Sync bị chặn vì một lần đẩy/kéo sẽ xoá hàng loạt dữ liệu (vd một máy khác
 * hoặc instance lạ đẩy vault gần rỗng). Auto-sync đã tạm dừng; người dùng chọn giữ
 * bên nào. Mọi lựa chọn ghi đè đều có sao lưu (máy này: backups/, cloud: lịch sử repo).
 */
export function SyncGuardDialog() {
  const [guard, setGuard] = useState<SyncGuard | null>(null);
  const [busy, setBusy] = useState<"local" | "remote" | null>(null);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = listen<SyncGuard>("sync:guard", (e) => setGuard(e.payload));
    } catch {
      /* ngoài app */
    }
    return () => {
      un?.then((f) => f()).catch(() => {});
    };
  }, []);

  async function resolve(choice: "local" | "remote") {
    const ok = await confirmDialog({
      title: choice === "local" ? "Overwrite the cloud vault?" : "Replace this device's data?",
      message:
        choice === "local"
          ? "The cloud vault will be replaced by this device's data. Older versions stay in the repo history (Cloud Sync → Version history)."
          : "This device's hosts, keys, vault and storage connections will be replaced by the cloud vault. A backup of the current data is saved in the app's backups folder.",
      confirmText: choice === "local" ? "Overwrite cloud" : "Replace local data",
      danger: true,
    });
    if (!ok) return;
    setBusy(choice);
    try {
      await api.syncResolveConflict(choice);
      await refresh();
      setGuard(null);
    } catch (e) {
      alertDialog({ title: "Cloud Sync", message: String(e) });
    } finally {
      setBusy(null);
    }
  }

  const pull = guard?.direction === "pull";

  return (
    <Dialog open={guard !== null} onOpenChange={(o) => !o && !busy && setGuard(null)}>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-500" /> Cloud Sync paused
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {pull
            ? "The cloud vault would delete a large part of the data on this device:"
            : "This device would delete a large part of the data in the cloud vault:"}
        </p>
        <div className="selectable rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-500">
          {guard?.details}
        </div>
        <p className="text-sm text-muted-foreground">
          Auto-sync is paused until you decide. If you didn't delete these on purpose, the other side is probably the
          one to keep. Older cloud versions can also be restored from Cloud Sync → Version history.
        </p>
        <DialogFooter className="!flex-col gap-2 sm:items-stretch">
          {pull ? (
            <>
              <Button disabled={busy !== null} onClick={() => resolve("local")}>
                {busy === "local" && <Loader2 className="size-4 animate-spin" />}
                Keep this device's data (overwrite cloud)
              </Button>
              <Button variant="outline" disabled={busy !== null} onClick={() => resolve("remote")}>
                {busy === "remote" && <Loader2 className="size-4 animate-spin" />}
                Use the cloud version (delete them here — backup kept)
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy !== null} onClick={() => resolve("remote")}>
                {busy === "remote" && <Loader2 className="size-4 animate-spin" />}
                Restore this device from the cloud (backup kept)
              </Button>
              <Button variant="outline" disabled={busy !== null} onClick={() => resolve("local")}>
                {busy === "local" && <Loader2 className="size-4 animate-spin" />}
                Push anyway (overwrite cloud)
              </Button>
            </>
          )}
          <Button variant="ghost" disabled={busy !== null} onClick={() => setGuard(null)}>
            Decide later (auto-sync stays paused)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
