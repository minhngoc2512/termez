import { useEffect, useState } from "react";
import { DialogRequest, registerDialogHost } from "../lib/dialogs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState("");
  const cur = queue[0] ?? null;

  useEffect(() => registerDialogHost((req) => setQueue((q) => [...q, req])), []);
  useEffect(() => {
    if (cur?.kind === "prompt") setValue(cur.opts.initial ?? "");
  }, [cur]);

  function finish(result: boolean | string | null | void) {
    if (!cur) return;
    (cur.resolve as (v: typeof result) => void)(result);
    setQueue((q) => q.slice(1));
  }

  // Đóng bằng Esc / click nền = huỷ.
  function onOpenChange(open: boolean) {
    if (open || !cur) return;
    if (cur.kind === "confirm") finish(false);
    else if (cur.kind === "prompt") finish(null);
    else finish();
  }

  const title =
    cur?.opts.title ??
    (cur?.kind === "confirm" ? "Confirm" : cur?.kind === "alert" ? "Notice" : "");

  return (
    <Dialog open={cur !== null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {cur?.kind === "prompt" ? (
          <>
            {cur.opts.message && <p className="text-sm text-muted-foreground">{cur.opts.message}</p>}
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) finish(value); }}
              placeholder={cur.opts.placeholder}
            />
          </>
        ) : (
          cur && <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{cur.opts.message}</p>
        )}

        <DialogFooter>
          {cur?.kind === "alert" ? (
            <Button onClick={() => finish()}>{cur.opts.okText ?? "OK"}</Button>
          ) : cur?.kind === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => finish(false)}>
                {cur.opts.cancelText ?? "Cancel"}
              </Button>
              <Button
                variant={cur.opts.danger ? "destructive" : "default"}
                onClick={() => finish(true)}
              >
                {cur.opts.confirmText ?? "Confirm"}
              </Button>
            </>
          ) : cur?.kind === "prompt" ? (
            <>
              <Button variant="outline" onClick={() => finish(null)}>Cancel</Button>
              <Button
                variant={cur.opts.danger ? "destructive" : "default"}
                disabled={!value.trim()}
                onClick={() => finish(value)}
              >
                {cur.opts.confirmText ?? "OK"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
