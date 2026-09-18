import { Loader2, AlertTriangle, RefreshCw, X } from "lucide-react";
import { ConnStatus } from "../lib/terminalPool";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";

/**
 * Popup trạng thái kết nối SSH. Hiện khi đang "Connecting…"; nếu fail thì hiện
 * lỗi + nút Retry / Exit. z-40 để hộp thoại host-key (Radix, z-50) vẫn nổi lên.
 */
export function ConnectStatus({
  status,
  onRetry,
  onExit,
}: {
  status: ConnStatus | null;
  onRetry: () => void;
  onExit: () => void;
}) {
  const hosts = useStore((s) => s.hosts);
  if (!status || status.state === "connected") return null;

  const label = hosts.find((h) => h.id === status.hostId)?.label || "host";
  const connecting = status.state === "connecting";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        {connecting ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <div className="text-base font-semibold">Connecting…</div>
            <div className="text-sm text-muted-foreground">
              Opening SSH to <span className="font-medium text-foreground">{label}</span>
            </div>
            <Button variant="outline" size="sm" className="mt-1" onClick={onExit}>Cancel</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
                <AlertTriangle className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="text-base font-semibold">Connection failed</div>
                <div className="truncate text-sm text-muted-foreground">{label}</div>
              </div>
            </div>
            {status.error && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs text-destructive">
                {status.error}
              </pre>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onExit}>
                <X className="size-4" /> Exit
              </Button>
              <Button size="sm" onClick={onRetry}>
                <RefreshCw className="size-4" /> Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
