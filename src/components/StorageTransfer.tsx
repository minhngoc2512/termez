import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft, Folder, File as FileIcon, Home, ChevronRight, RefreshCw, ArrowRight, ArrowLeftRight, Loader2,
} from "lucide-react";
import { api, S3Listing, StorageBucket } from "../lib/ipc";
import { alertDialog } from "../lib/dialogs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface PaneState { bucketId: string; prefix: string; selected: Set<string> }
interface Item { key: string; isFolder: boolean; name: string }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function basename(p: string): string {
  return p.replace(/\/$/, "").split("/").pop() || p;
}
function paneItems(p: PaneState): Item[] {
  return [...p.selected].map((k) =>
    k.endsWith("/") ? { key: k, isFolder: true, name: basename(k) } : { key: k, isFolder: false, name: k.slice(p.prefix.length) }
  );
}

export function StorageTransfer({ buckets, onBack }: { buckets: StorageBucket[]; onBack: () => void }) {
  const [left, setLeft] = useState<PaneState>({ bucketId: buckets[0]?.id ?? "", prefix: "", selected: new Set() });
  const [right, setRight] = useState<PaneState>({ bucketId: buckets[1]?.id ?? buckets[0]?.id ?? "", prefix: "", selected: new Set() });
  const [reloadL, setReloadL] = useState(0);
  const [reloadR, setReloadR] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number; file: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = listen<{ done: number; total: number; file: string; fin: boolean }>("s3:xfer", (e) => {
        setProgress(e.payload.fin ? null : { done: e.payload.done, total: e.payload.total, file: e.payload.file });
      });
    } catch { /* ngoài Tauri */ }
    return () => { un?.then((f) => f()).catch(() => {}); };
  }, []);

  async function transfer(dir: "LR" | "RL") {
    const src = dir === "LR" ? left : right;
    const dst = dir === "LR" ? right : left;
    const its = paneItems(src);
    if (its.length === 0) return;
    if (src.bucketId === dst.bucketId && src.prefix === dst.prefix) {
      return alertDialog({ title: "Transfer", message: "Source and destination are the same folder." });
    }
    setBusy(true);
    setProgress({ done: 0, total: its.length, file: "" });
    try {
      for (const it of its) {
        if (it.isFolder) await api.s3TransferPrefix(src.bucketId, it.key, dst.bucketId, dst.prefix + it.name + "/");
        else await api.s3Transfer(src.bucketId, it.key, dst.bucketId, dst.prefix + basename(it.key));
      }
      (dir === "LR" ? setLeft : setRight)((p) => ({ ...p, selected: new Set() }));
      (dir === "LR" ? setReloadR : setReloadL)((n) => n + 1);
    } catch (e) {
      alertDialog({ title: "Transfer failed", message: String(e) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <button onClick={onBack} title="Back" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-4" />
        </button>
        <ArrowLeftRight className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Transfer between buckets</h1>
      </div>

      <div className="flex min-h-0 flex-1">
        <BucketPane buckets={buckets} state={left} patch={(u) => setLeft((p) => ({ ...p, ...u }))} reloadKey={reloadL} />

        <div className="flex flex-col items-center justify-center gap-2 border-x border-border px-2">
          <Button size="icon" className="size-10" title="Copy selected → right" disabled={busy || left.selected.size === 0} onClick={() => transfer("LR")}>
            <ArrowRight className="size-5" />
          </Button>
          <Button size="icon" variant="outline" className="size-10" title="Copy selected ← left" disabled={busy || right.selected.size === 0} onClick={() => transfer("RL")}>
            <ArrowLeft className="size-5" />
          </Button>
        </div>

        <BucketPane buckets={buckets} state={right} patch={(u) => setRight((p) => ({ ...p, ...u }))} reloadKey={reloadR} />
      </div>

      {progress && (
        <div className="border-t border-border bg-card px-5 py-2.5">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 truncate text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {progress.file ? `Transferring ${basename(progress.file)}` : "Transferring…"}
            </span>
            <span className="tabular-nums text-muted-foreground">{progress.done} / {progress.total}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function BucketPane({
  buckets, state, patch, reloadKey,
}: {
  buckets: StorageBucket[];
  state: PaneState;
  patch: (u: Partial<PaneState>) => void;
  reloadKey: number;
}) {
  const [listing, setListing] = useState<S3Listing | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!state.bucketId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const l = await api.s3List(state.bucketId, state.prefix);
        if (alive) setListing(l);
      } catch (e) {
        if (alive) { setListing(null); alertDialog({ title: "Storage", message: String(e) }); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.bucketId, state.prefix, reloadKey]);

  const crumbs = state.prefix.split("/").filter(Boolean);
  const bucket = buckets.find((b) => b.id === state.bucketId);
  function toggle(key: string) {
    const n = new Set(state.selected);
    n.has(key) ? n.delete(key) : n.add(key);
    patch({ selected: n });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Select value={state.bucketId} onValueChange={(v) => patch({ bucketId: v, prefix: "", selected: new Set() })}>
          <SelectTrigger className="h-8"><SelectValue placeholder="Bucket…" /></SelectTrigger>
          <SelectContent>{buckets.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
        </Select>
        <button title="Refresh" onClick={() => patch({})} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
        <button onClick={() => patch({ prefix: "", selected: new Set() })} className="flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Home className="size-3" /> {bucket?.bucket ?? "root"}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground" />
            <button onClick={() => patch({ prefix: crumbs.slice(0, i + 1).join("/") + "/", selected: new Set() })} className="rounded px-1 py-0.5 hover:bg-accent">{c}</button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!listing || (listing.prefixes.length === 0 && listing.objects.filter((o) => o.key !== state.prefix).length === 0) ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{loading ? "Loading…" : "Empty"}</div>
        ) : (
          <div className="p-1 text-sm">
            {listing.prefixes.map((p) => (
              <div key={p} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
                <Checkbox checked={state.selected.has(p)} onCheckedChange={() => toggle(p)} />
                <button onClick={() => patch({ prefix: p, selected: new Set() })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Folder className="size-4 shrink-0 text-primary" />
                  <span className="truncate font-medium">{basename(p)}/</span>
                </button>
              </div>
            ))}
            {listing.objects.filter((o) => o.key !== state.prefix).map((o) => (
              <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
                <Checkbox checked={state.selected.has(o.key)} onCheckedChange={() => toggle(o.key)} />
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{o.key.slice(state.prefix.length)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtSize(o.size)}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
