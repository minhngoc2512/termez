import { useEffect, useState } from "react";
import { Download, Sparkles, Loader2, X } from "lucide-react";
import { api } from "../lib/ipc";
import { alertDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";

type Avail = { current: string; latest: string; url: string; notes: string };

function ls(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/**
 * Quản lý cập nhật:
 * - Sau khi cập nhật (version đổi so với lần chạy trước) → popup "đã cập nhật" + changelog.
 * - Nếu bật auto-update: lúc mở app kiểm tra bản mới → hộp thoại cập nhật.
 * - Cài đặt qua `pkexec apt` (polkit hỏi mật khẩu) rồi khởi động lại.
 */
export function UpdateManager() {
  const autoUpdate = useStore((s) => s.autoUpdate);
  const [avail, setAvail] = useState<Avail | null>(null);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ version: string; notes: string } | null>(null);

  useEffect(() => {
    (async () => {
      // 1) Phát hiện vừa cập nhật xong (version khác lần chạy trước).
      let current = "";
      try {
        current = await api.appVersion();
      } catch {
        return; // ngoài Tauri
      }
      const last = ls("last-version", "");
      if (current && last && last !== current) {
        const notes = await api.releaseNotes(`v${current}`).catch(() => "");
        setDone({ version: current, notes });
      }
      if (current) lsSet("last-version", current);

      // 2) Tự kiểm tra bản mới (nếu bật).
      if (autoUpdate) {
        const u = await api.checkUpdate().catch(() => null);
        if (u?.has_update) setAvail(u);
      }
    })();
    // chỉ chạy lúc mở app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyUpdate() {
    setApplying(true);
    try {
      await api.updateApply();
      lsSet("last-version", ""); // để lần mở lại hiện popup "đã cập nhật"
      setAvail(null);
      // Khởi động lại để dùng bản mới.
      await api.appRelaunch();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("NOUPDATE|")) {
        // apt repo chưa có bản mới → không phải lỗi, báo nhẹ nhàng.
        alertDialog({ title: "Chưa có bản cập nhật", message: msg.split("NOUPDATE|")[1] });
        setAvail(null);
      } else {
        alertDialog({ title: "Cập nhật thất bại", message: msg });
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      {avail && (
        <Modal onClose={() => !applying && setAvail(null)}>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Download className="size-6" />
            </span>
            <div>
              <div className="text-lg font-semibold">Có bản mới — v{avail.latest}</div>
              <div className="text-sm text-muted-foreground">Bạn đang dùng v{avail.current}.</div>
            </div>
          </div>
          {avail.notes && <Changelog text={avail.notes} />}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setAvail(null)} disabled={applying}>Để sau</Button>
            <Button size="sm" onClick={applyUpdate} disabled={applying}>
              {applying ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {applying ? "Đang cập nhật…" : "Cập nhật ngay"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Cập nhật qua apt — hệ thống sẽ hỏi mật khẩu, rồi app tự khởi động lại.
          </p>
        </Modal>
      )}

      {done && (
        <Modal onClose={() => setDone(null)}>
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Sparkles className="size-6" />
            </span>
            <div>
              <div className="text-lg font-semibold">Đã cập nhật lên v{done.version}</div>
              <div className="text-sm text-muted-foreground">Termez vừa được nâng cấp.</div>
            </div>
          </div>
          {done.notes && <Changelog text={done.notes} />}
          <div className="mt-5 flex justify-end">
            <Button size="sm" onClick={() => setDone(null)}>Tuyệt!</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Changelog({ text }: { text: string }) {
  return (
    <pre className="mt-4 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
      {text.slice(0, 4000)}
    </pre>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-4" />
        </button>
        {children}
      </div>
    </div>
  );
}
