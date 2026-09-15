import { useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Server, ChevronDown, Search } from "lucide-react";
import { Host } from "../lib/ipc";

interface Props {
  hosts: Host[];
  value: string; // "local" hoặc host id
  onChange: (endpoint: string) => void;
}

export function EndpointPicker({ hosts, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = useMemo(() => {
    if (value === "local") return { icon: <Monitor className="size-4" />, label: "Local" };
    const h = hosts.find((x) => x.id === value);
    return { icon: <Server className="size-4" />, label: h ? h.label : "(select endpoint)" };
  }, [value, hosts]);

  const q = query.trim().toLowerCase();
  const showLocal = q === "" || "local".includes(q);
  const filtered = useMemo(
    () =>
      hosts.filter(
        (h) =>
          !q ||
          h.label.toLowerCase().includes(q) ||
          h.address.toLowerCase().includes(q) ||
          h.username.toLowerCase().includes(q)
      ),
    [hosts, q]
  );

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(ep: string) {
    onChange(ep);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="relative min-w-0 flex-1" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm hover:border-slate-600"
      >
        {current.icon}
        <span className="flex-1 truncate text-left">{current.label}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-lg border border-slate-600 bg-popover shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border px-2.5">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              placeholder="Search server…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent py-2 text-sm outline-none"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {showLocal && (
              <button
                onClick={() => pick("local")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <Monitor className="size-4" /> Local
              </button>
            )}
            {filtered.map((h) => (
              <button
                key={h.id}
                onClick={() => pick(h.id)}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm">
                  <Server className="size-4" /> {h.label}
                </span>
                <span className="truncate pl-6 text-[11px] text-muted-foreground">
                  {h.username}@{h.address}
                </span>
              </button>
            ))}
            {!showLocal && filtered.length === 0 && (
              <div className="px-2 py-2.5 text-center text-sm text-muted-foreground">
                No matching server
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
