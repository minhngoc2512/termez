import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Server, X } from "lucide-react";
import { Host } from "../lib/ipc";
import { useStore } from "../store";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (h: Host) => void;
}

/** Popup chọn/search host để mở một SSH session (task) mới. */
export function HostPicker({ open, onOpenChange, onPick }: Props) {
  const hosts = useStore((s) => s.hosts);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? hosts.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.address.toLowerCase().includes(s) ||
            h.username.toLowerCase().includes(s)
        )
      : hosts;
    return list.slice(0, 50);
  }, [hosts, q]);

  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  function choose(h: Host) {
    onPick(h);
    onOpenChange(false);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { if (results[idx]) choose(results[idx]); }
    else if (e.key === "Escape") onOpenChange(false);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search a host by name, IP or user…"
            className="w-full bg-transparent py-3 text-sm outline-none"
          />
          <button onClick={() => onOpenChange(false)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {hosts.length === 0 ? "No hosts yet." : "No host found."}
            </div>
          ) : (
            results.map((h, i) => (
              <button
                key={h.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(h)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  i === idx ? "bg-accent" : "hover:bg-accent"
                )}
              >
                <Server className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{h.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{h.username}@{h.address}{h.port !== 22 ? `:${h.port}` : ""}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
