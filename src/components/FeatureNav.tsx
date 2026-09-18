import {
  Server, Key, Cable, FolderOpen, KeyRound, Code2, ShieldCheck, Radar, Globe, HardDrive, Settings, Cloud, CloudOff,
  SquareTerminal, ChevronRight, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "../store";

export type Section =
  | "hosts"
  | "keychain"
  | "forwarding"
  | "sftp"
  | "passwords"
  | "snippets"
  | "known"
  | "scan"
  | "dns"
  | "storage"
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
  { id: "sftp", label: "SFTP", icon: FolderOpen },
  { id: "passwords", label: "Passwords", icon: KeyRound },
  { id: "snippets", label: "Snippets", icon: Code2 },
  { id: "known", label: "Known Hosts", icon: ShieldCheck },
  { id: "scan", label: "Network Scan", icon: Radar },
  { id: "dns", label: "Cloudflare DNS", icon: Globe },
  { id: "storage", label: "Storage", icon: HardDrive },
];

export interface Session {
  id: string;
  title: string;
}

interface Props {
  section: Section;
  onSelect: (s: Section) => void;
  onSync: () => void;
  syncConfigured?: boolean;
  sessions?: Session[];
  activeSession?: string | null;
  onOpenSession?: (id: string) => void;
  onCloseSession?: (id: string) => void;
}

export function FeatureNav({ section, onSelect, onSync, syncConfigured = true, sessions = [], activeSession, onOpenSession, onCloseSession }: Props) {
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
        {sessions.length > 0 && onOpenSession && (
          <div className="mb-2 border-b border-border pb-2">
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <SquareTerminal className="size-3.5" />
              Open sessions
              <span className="ml-auto tabular-nums opacity-70">{sessions.length}</span>
            </div>
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => onOpenSession(s.id)}
                title={s.title}
                className={cn(
                  "group mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
                  s.id === activeSession
                    ? "bg-primary/15 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                <span className="flex-1 truncate text-left">{s.title}</span>
                {onCloseSession ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onCloseSession(s.id); }}
                    title="Close session"
                    className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-border hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                )}
              </div>
            ))}
          </div>
        )}
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
        <NavRow
          icon={syncConfigured ? Cloud : CloudOff}
          iconClassName={syncConfigured ? undefined : "text-red-500"}
          label="Cloud Sync"
          title={syncConfigured ? undefined : "Chưa cấu hình đồng bộ"}
          onClick={onSync}
        />
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
  iconClassName,
  label,
  title,
  badge,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  label: string;
  title?: string;
  badge?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary/15 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      <Icon className={cn("size-4 shrink-0", iconClassName)} />
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
