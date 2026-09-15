import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

async function ctl(action: "min" | "max" | "close") {
  try {
    const w = getCurrentWindow();
    if (action === "min") await w.minimize();
    else if (action === "max") await w.toggleMaximize();
    else await w.close();
  } catch {
    /* ngoài môi trường Tauri (preview) */
  }
}

export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar pl-3"
    >
      <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2 text-sm">
        <span className="font-semibold">⌘ Termez</span>
      </div>
      <div className="flex items-center">
        <button
          onClick={() => ctl("min")}
          className="flex h-8 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Minimize"
        >
          <Minus className="size-4" />
        </button>
        <button
          onClick={() => ctl("max")}
          className="flex h-8 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Maximize"
        >
          <Square className="size-3.5" />
        </button>
        <button
          onClick={() => ctl("close")}
          className="flex h-8 w-11 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-white"
          title="Close"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
