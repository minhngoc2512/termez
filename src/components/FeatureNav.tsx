import {
  Server, Key, Cable, KeyRound, Code2, ShieldCheck, Radar, Settings, Cloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "../store";

export type Section =
  | "hosts"
  | "keychain"
  | "forwarding"
  | "passwords"
  | "snippets"
  | "known"
  | "scan"
  | "settings";

interface Item {
  id: Section;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TOP: Item[] = [
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "keychain", label: "Keychain", icon: Key },
  { id: "forwarding", label: "Port Forwarding", icon: Cable },
  { id: "passwords", label: "Passwords", icon: KeyRound },
  { id: "snippets", label: "Snippets", icon: Code2 },
  { id: "known", label: "Known Hosts", icon: ShieldCheck },
  { id: "scan", label: "Network Scan", icon: Radar },
];

interface Props {
  section: Section;
  onSelect: (s: Section) => void;
  onSync: () => void;
}

export function FeatureNav({ section, onSelect, onSync }: Props) {
  const hosts = useStore((s) => s.hosts);
  const entries = useStore((s) => s.entries);
  const tunnels = useStore((s) => s.tunnels);
  const keys = useStore((s) => s.keys);

  const badges: Partial<Record<Section, number>> = {
    hosts: hosts.length,
    keychain: keys.length,
    forwarding: tunnels.length,
    passwords: entries.length,
  };

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-sidebar">
      <nav className="flex-1 overflow-y-auto p-2">
        {TOP.map((it) => (
          <NavRow
            key={it.id}
            active={section === it.id}
            icon={it.icon}
            label={it.label}
            badge={badges[it.id]}
            onClick={() => onSelect(it.id)}
          />
        ))}
      </nav>
      <div className="border-t border-border p-2">
        <NavRow icon={Cloud} label="Cloud Sync" onClick={onSync} />
        <NavRow
          icon={Settings}
          label="Settings"
          active={section === "settings"}
          onClick={() => onSelect("settings")}
        />
      </div>
    </aside>
  );
}

function NavRow({
  icon: Icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary/15 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate text-left">{label}</span>
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[11px] tabular-nums",
            active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
