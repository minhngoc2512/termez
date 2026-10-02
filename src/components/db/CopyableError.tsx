import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { cn } from "@/lib/utils";

/** Thông báo (thường là lỗi) bôi đen được + nút Copy ở góc. */
export function CopyableError({
  text,
  className,
  tone = "error",
  mono = true,
}: {
  text: string;
  className?: string;
  tone?: "error" | "ok";
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("group relative", className)}>
      <pre
        className={cn(
          "selectable h-full overflow-auto whitespace-pre-wrap break-words pr-16 text-xs",
          mono ? "font-mono" : "font-sans",
          tone === "error" ? "text-destructive" : "text-primary"
        )}
      >
        {text}
      </pre>
      <button
        type="button"
        title="Copy message"
        onClick={() => {
          copyText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => {});
        }}
        className="absolute right-0 top-0 flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-80 hover:text-foreground hover:opacity-100"
      >
        {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
