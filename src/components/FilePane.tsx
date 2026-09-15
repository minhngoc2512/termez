import { useEffect, useState } from "react";
import { Folder, File as FileIcon, ArrowUp, FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import { api, FileEntry, Host, joinPath, parentPath } from "../lib/ipc";
import { EndpointPicker } from "./EndpointPicker";
import { cn } from "@/lib/utils";

export interface PaneState {
  endpoint: string;
  path: string;
  selected: FileEntry | null;
}

export interface DragPayload {
  endpoint: string;
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
}

const DRAG_MIME = "application/x-termez-file";

interface Props {
  hosts: Host[];
  side: "left" | "right";
  reloadKey: number;
  onChange: (s: PaneState) => void;
  onDropTransfer: (payload: DragPayload, side: "left" | "right") => void;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function FilePane({ hosts, side, reloadKey, onChange, onDropTransfer }: Props) {
  const [endpoint, setEndpoint] = useState("local");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setSelected(null);
      setEntries([]);
      try {
        if (endpoint !== "local") await api.sftpOpen(endpoint);
        const home = await api.fsHome(endpoint);
        if (!cancelled) setPath(home);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await api.fsList(endpoint, path);
      list.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
      setEntries(list);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (path) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, path, reloadKey]);

  useEffect(() => {
    onChange({ endpoint, path, selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, path, selected]);

  function openEntry(entry: FileEntry) {
    if (entry.is_dir) {
      setSelected(null);
      setPath(joinPath(path, entry.name));
    } else {
      setSelected(entry.name === selected?.name ? null : entry);
    }
  }

  async function mkdir() {
    const name = prompt("New folder name:");
    if (!name) return;
    try {
      await api.fsMkdir(endpoint, joinPath(path, name));
      load();
    } catch (e) {
      alert(String(e));
    }
  }

  async function del(entry: FileEntry, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${entry.name}"?`)) return;
    try {
      await api.fsDelete(endpoint, joinPath(path, entry.name), entry.is_dir);
      load();
    } catch (err) {
      alert(String(err));
    }
  }

  const iconBtn =
    "rounded-md border border-border p-1.5 text-foreground hover:border-slate-600 disabled:opacity-40";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border p-2">
        <EndpointPicker hosts={hosts} value={endpoint} onChange={setEndpoint} />
        <button className={iconBtn} title="Go to parent folder" onClick={() => setPath(parentPath(path))}>
          <ArrowUp className="size-4" />
        </button>
        <button className={iconBtn} title="New folder" onClick={mkdir}>
          <FolderPlus className="size-4" />
        </button>
        <button className={iconBtn} title="Reload" onClick={load}>
          <RefreshCw className="size-4" />
        </button>
      </div>

      <div
        className="truncate border-b border-border px-2.5 py-1.5 text-left font-mono text-xs text-muted-foreground"
        dir="rtl"
        title={path}
      >
        {path || "…"}
      </div>

      <div
        className={cn(
          "flex-1 overflow-y-auto border-2 border-transparent p-1",
          dragOver && "border-primary bg-primary/[0.07]"
        )}
        onDragOver={(ev) => {
          if (ev.dataTransfer.types.includes(DRAG_MIME)) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(ev) => {
          ev.preventDefault();
          setDragOver(false);
          const raw = ev.dataTransfer.getData(DRAG_MIME);
          if (!raw) return;
          try {
            onDropTransfer(JSON.parse(raw) as DragPayload, side);
          } catch {
            /* ignore */
          }
        }}
      >
        {error && <div className="p-2.5 text-sm text-destructive">{error}</div>}
        {loading && <div className="p-3 text-center text-muted-foreground">Loading…</div>}
        {!loading &&
          entries.map((entry) => (
            <div
              key={entry.name}
              draggable={!entry.is_dir}
              onDragStart={(ev) => {
                const payload: DragPayload = {
                  endpoint,
                  path,
                  name: entry.name,
                  is_dir: entry.is_dir,
                  size: entry.size,
                };
                ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                ev.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => openEntry(entry)}
              className={cn(
                "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent",
                selected?.name === entry.name && "bg-primary/[0.16] outline outline-1 outline-primary"
              )}
            >
              {entry.is_dir ? (
                <Folder className="size-4 shrink-0 text-primary" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 truncate text-sm">{entry.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {entry.is_dir ? "" : fmtSize(entry.size)}
              </span>
              <button
                className="hidden text-muted-foreground hover:text-destructive group-hover:inline"
                title="Delete"
                onClick={(ev) => del(entry, ev)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        {!loading && entries.length === 0 && !error && (
          <div className="p-3 text-center text-muted-foreground">(empty)</div>
        )}
      </div>
    </div>
  );
}
