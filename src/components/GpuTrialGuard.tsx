import { useEffect, useState } from "react";
import { MonitorCheck } from "lucide-react";
import { api } from "../lib/ipc";
import { Button } from "@/components/ui/button";

const TRIAL_SECONDS = 20;

/**
 * App đang chạy thử tăng tốc GPU (DMABUF) → hỏi màn hình có bình thường không.
 * Cờ trên đĩa đã bị đặt về "off" lúc khởi động (render.rs), nên:
 * - Giữ → ghi "on".
 * - Hoàn tác → khởi động lại về chế độ an toàn.
 * - Không làm gì → lần mở sau tự tắt.
 */
export function GpuTrialGuard() {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(TRIAL_SECONDS);

  useEffect(() => {
    api
      .renderStatus()
      .then((s) => s.trial && setOpen(true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    if (left <= 0) {
      setOpen(false);
      return;
    }
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [open, left]);

  if (!open) return null;

  async function keep() {
    await api.renderConfirmDmabuf().catch(() => {});
    setOpen(false);
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <MonitorCheck className="size-6" />
          </span>
          <div>
            <div className="text-lg font-semibold">Đang thử tăng tốc GPU</div>
            <div className="text-sm text-muted-foreground">Màn hình có hiển thị bình thường không?</div>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Bấm <b className="text-foreground">Giữ</b> để lưu. Không bấm gì trong{" "}
          <span className="tabular-nums text-foreground">{left}s</span> thì lần mở sau app tự quay về chế độ an toàn.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => api.appRelaunch().catch(() => {})}>
            Hoàn tác
          </Button>
          <Button size="sm" onClick={keep}>
            Giữ
          </Button>
        </div>
      </div>
    </div>
  );
}
