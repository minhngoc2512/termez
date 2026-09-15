import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Server } from "lucide-react";
import { Host } from "../lib/ipc";
import { useStore } from "../store";
import { cn } from "@/lib/utils";

interface Props {
  onOpen: (h: Host) => void;
}

export function HostSearch({ onOpen }: Props) {
  const hosts = useStore((s) => s.hosts);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return hosts
      .filter(
        (h) =>
          h.label.toLowerCase().includes(s) ||
          h.address.toLowerCase().includes(s) ||
          h.username.toLowerCase().includes(s)
      )
      .slice(0, 8);
  }, [hosts, q]);

  useEffect(() => setIdx(0), [q]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function choose(h: Host) {
    onOpen(h);
    setQ("");
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (results[idx]) choose(results[idx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    }
  }

  return (
    <div className="relative min-w-0 flex-1" ref={wrapRef}>
      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="Search a host by name or IP…  (Enter to open)"
          className="w-full bg-transparent py-1.5 text-sm outline-none"
        />
      </div>

      {open && q.trim() !== "" && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-lg border border-slate-600 bg-popover shadow-2xl">
          {results.length === 0 ? (
            <div className="px-3 py-2.5 text-sm text-muted-foreground">No host found</div>
          ) : (
            <div className="max-h-72 overflow-y-auto p-1">
              {results.map((h, i) => (
                <button
                  key={h.id}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => choose(h)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    i === idx ? "bg-accent" : "hover:bg-accent"
                  )}
                >
                  <Server className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate text-sm">{h.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {h.username}@{h.address}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
