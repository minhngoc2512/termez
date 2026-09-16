// Dịch vụ dialog dạng gọi hàm (thay cho window.confirm/prompt/alert mặc định của trình duyệt).
// Dùng: `await confirmDialog({ message })`, `await promptDialog({ ... })`, `await alertDialog({ message })`.
// `<DialogHost/>` (mount 1 lần ở App) sẽ render dialog thật theo style của app.

export interface ConfirmOpts {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
export interface PromptOpts {
  title?: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  danger?: boolean;
}
export interface AlertOpts {
  title?: string;
  message: string;
  okText?: string;
}

export type DialogRequest =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: "alert"; opts: AlertOpts; resolve: () => void };

let listener: ((req: DialogRequest) => void) | null = null;

export function registerDialogHost(l: (req: DialogRequest) => void): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

function push(req: DialogRequest) {
  if (listener) listener(req);
  // Không có host (vd. môi trường test) → phân giải an toàn.
  else if (req.kind === "confirm") req.resolve(false);
  else if (req.kind === "prompt") req.resolve(null);
  else req.resolve();
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => push({ kind: "confirm", opts, resolve }));
}
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => push({ kind: "prompt", opts, resolve }));
}
export function alertDialog(opts: AlertOpts): Promise<void> {
  return new Promise((resolve) => push({ kind: "alert", opts, resolve }));
}
