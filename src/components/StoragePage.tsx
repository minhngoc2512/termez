import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import {
  HardDrive, Folder, File as FileIcon, Upload, RefreshCw, Trash2, Link2, Copy,
  ChevronRight, Home, Loader2, Plus, Settings, Check, Pencil, ArrowLeft, Database,
  Scissors, ClipboardPaste, X, Download, FolderOpen, UploadCloud, FolderPlus, ArrowLeftRight,
} from "lucide-react";
import { StorageTransfer } from "./StorageTransfer";
import { api, S3Listing, StorageBucket, StorageBucketInput } from "../lib/ipc";
import { confirmDialog, alertDialog, promptDialog } from "../lib/dialogs";
import { copyText } from "../lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Progress = { done: number; total: number; speed: number; file: string };

interface Item { key: string; isFolder: boolean; name: string }
type MenuState = { x: number; y: number; item: Item | null } | null;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
function basename(p: string): string {
  return p.replace(/\/$/, "").split(/[\\/]/).pop() || p;
}

export function StoragePage() {
  const [buckets, setBuckets] = useState<StorageBucket[]>([]);
  const [bucketId, setBucketId] = useState("");
  const [view, setView] = useState<"list" | "browse" | "transfer">("list");
  const [showConfig, setShowConfig] = useState(false);
  const [editing, setEditing] = useState<StorageBucket | null>(null);

  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<S3Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [clip, setClip] = useState<{ op: "copy" | "cut"; items: Item[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [conflict, setConflict] = useState<{ count: number; resolve: (m: string | null) => void } | null>(null);
  const ctx = useRef({ bucketId, prefix, view });
  const dropRef = useRef<(paths: string[]) => void>(() => {});
  useEffect(() => {
    ctx.current = { bucketId, prefix, view };
    dropRef.current = (paths) => {
      const c = ctx.current;
      if (c.view === "browse" && c.bucketId && paths.length) startUpload(paths, c.bucketId, c.prefix);
    };
  });

  useEffect(() => { loadBuckets(); }, []);

  // Nghe event tiến trình upload từ backend.
  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = listen<Progress & { fin: boolean }>("s3:progress", (e) => {
        setProgress(e.payload.fin ? null : { done: e.payload.done, total: e.payload.total, speed: e.payload.speed, file: e.payload.file });
      });
    } catch { /* ngoài Tauri */ }
    return () => { un?.then((f) => f()).catch(() => {}); };
  }, []);

  // Kéo-thả file/thư mục từ hệ điều hành vào để upload.
  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "over") setDragOver(true);
        else if (e.payload.type === "leave") setDragOver(false);
        else if (e.payload.type === "drop") {
          setDragOver(false);
          dropRef.current(e.payload.paths);
        }
      });
    } catch { /* ngoài Tauri */ }
    return () => { un?.then((f) => f()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (view === "browse" && bucketId) list();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketId, prefix, view]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  async function loadBuckets() {
    try {
      const b = await api.getBuckets();
      setBuckets(b);
      if (!b.length) { setShowConfig(true); setEditing(null); }
    } catch (e) {
      alertDialog({ title: "Storage", message: String(e) });
    }
  }
  function openBucket(id: string) { setBucketId(id); setPrefix(""); setView("browse"); }
  async function delBucket(b: StorageBucket) {
    if (!(await confirmDialog({ title: "Delete connection", message: `Remove "${b.name}"? (access keys are erased)`, confirmText: "Delete", danger: true }))) return;
    await api.deleteBucket(b.id);
    if (bucketId === b.id) { setBucketId(""); setView("list"); }
    await loadBuckets();
  }

  async function list() {
    if (!bucketId) return;
    setLoading(true);
    try {
      setListing(await api.s3List(bucketId, prefix));
    } catch (e) {
      alertDialog({ title: "Storage", message: String(e) });
      setListing(null);
    } finally {
      setLoading(false);
    }
  }

  function askConflict(count: number): Promise<string | null> {
    return new Promise((resolve) => setConflict({ count, resolve }));
  }

  async function startUpload(paths: string[], bId: string, pfx: string) {
    try {
      const plan = await api.s3UploadPlan(bId, pfx, paths);
      if (plan.count === 0) return;
      let mode = "overwrite";
      if (plan.conflicts.length > 0) {
        const m = await askConflict(plan.conflicts.length);
        if (!m) return;
        mode = m;
      }
      setProgress({ done: 0, total: plan.total, speed: 0, file: "" });
      await api.s3UploadRun(bId, pfx, paths, mode);
      if (ctx.current.bucketId === bId && ctx.current.prefix === pfx) await list();
    } catch (e) {
      alertDialog({ title: "Upload failed", message: String(e) });
    } finally {
      setProgress(null);
    }
  }

  async function upload() {
    const sel = await open({ multiple: true, directory: false });
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    if (paths.length) startUpload(paths, bucketId, prefix);
  }

  async function download(item: Item) {
    if (item.isFolder) return alertDialog({ title: "Download", message: "Folder download isn't supported — open it and select files." });
    const dest = await save({ defaultPath: item.name });
    if (typeof dest !== "string") return;
    setLoading(true);
    try {
      await api.s3Download(bucketId, item.key, dest);
    } catch (e) {
      alertDialog({ title: "Download failed", message: String(e) });
    } finally {
      setLoading(false);
    }
  }
  async function downloadSelected() {
    const files = selItems().filter((i) => !i.isFolder);
    if (files.length === 0) return alertDialog({ title: "Download", message: "Select one or more files (folders aren't supported)." });
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setLoading(true);
    try {
      for (const f of files) await api.s3Download(bucketId, f.key, `${dir}/${f.name}`);
      alertDialog({ title: "Download", message: `Downloaded ${files.length} file(s) to ${dir}` });
    } catch (e) {
      alertDialog({ title: "Download failed", message: String(e) });
    } finally {
      setLoading(false);
    }
  }

  async function removeItems(items: Item[]) {
    if (items.length === 0) return;
    const msg = items.length === 1 ? `Delete "${items[0].name}"?` : `Delete ${items.length} selected items?`;
    if (!(await confirmDialog({ title: "Delete", message: msg, confirmText: "Delete", danger: true }))) return;
    setLoading(true);
    try {
      for (const it of items) {
        if (it.isFolder) await api.s3DeletePrefix(bucketId, it.key);
        else await api.s3Delete(bucketId, it.key);
      }
      setSelected(new Set());
      await list();
    } catch (e) {
      alertDialog({ title: "Delete failed", message: String(e) });
    } finally {
      setLoading(false);
    }
  }

  async function copyUrl(key: string) {
    try {
      const url = await api.s3Presign(bucketId, key, 3600);
      await copyText(url);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
    } catch (e) {
      alertDialog({ title: "Storage", message: String(e) });
    }
  }

  function putClip(op: "copy" | "cut", items: Item[]) {
    if (items.length) { setClip({ op, items }); setSelected(new Set()); }
  }
  async function paste() {
    if (!clip) return;
    setLoading(true);
    try {
      for (const it of clip.items) {
        if (it.isFolder) await api.s3CopyPrefix(bucketId, it.key, prefix + it.name + "/", clip.op === "cut");
        else await api.s3Copy(bucketId, it.key, prefix + basename(it.key), clip.op === "cut");
      }
      if (clip.op === "cut") setClip(null);
      await list();
    } catch (e) {
      alertDialog({ title: "Paste failed", message: String(e) });
    } finally {
      setLoading(false);
    }
  }

  // ----- selection helpers -----
  function toggleSel(key: string) {
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function selItems(): Item[] {
    return [...selected].map((k) =>
      k.endsWith("/")
        ? { key: k, isFolder: true, name: basename(k) }
        : { key: k, isFolder: false, name: k.slice(prefix.length) }
    );
  }
  const allKeys = listing ? [...listing.prefixes, ...listing.objects.filter((o) => o.key !== prefix).map((o) => o.key)] : [];
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  function openMenu(e: React.MouseEvent, item: Item | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, item });
  }

  async function createFolder() {
    const name = await promptDialog({ title: "New folder", placeholder: "Folder name", confirmText: "Create" });
    const clean = name?.trim().replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
    if (!clean) return;
    try {
      await api.s3CreateFolder(bucketId, prefix + clean + "/");
      await list();
    } catch (err) {
      alertDialog({ title: "Storage", message: String(err) });
    }
  }

  // ---------- views ----------
  if (showConfig || (buckets.length === 0 && !bucketId)) {
    return (
      <BucketForm
        bucket={editing}
        onDone={async () => { setShowConfig(false); await loadBuckets(); }}
        onCancel={buckets.length ? () => setShowConfig(false) : undefined}
      />
    );
  }

  if (view === "transfer") {
    return <StorageTransfer buckets={buckets} onBack={() => setView("list")} />;
  }

  if (view === "list") {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <HardDrive className="size-4 text-primary" />
          <h1 className="text-base font-semibold">Storage</h1>
          <span className="text-sm text-muted-foreground">Buckets</span>
          {buckets.length > 0 && (
            <Button className="ml-auto" variant="outline" size="sm" onClick={() => setView("transfer")}>
              <ArrowLeftRight className="size-4" /> Transfer
            </Button>
          )}
          <Button className={buckets.length > 0 ? "" : "ml-auto"} size="sm" onClick={() => { setEditing(null); setShowConfig(true); }}>
            <Plus className="size-4" /> New connection
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {buckets.length === 0 ? (
            <div className="mt-10 flex flex-col items-center gap-3 text-muted-foreground">
              <Database className="size-10 opacity-40" /><p>No connections yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {buckets.map((b) => (
                <div key={b.id} onClick={() => openBucket(b.id)}
                  className="group relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/60 hover:bg-accent">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><Database className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{b.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{b.bucket}</div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{b.endpoint}</div>
                  </div>
                  <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                    <IconBtn title="Edit access info" onClick={(e) => { e.stopPropagation(); setEditing(b); setShowConfig(true); }}><Pencil className="size-4" /></IconBtn>
                    <IconBtn title="Delete" danger onClick={(e) => { e.stopPropagation(); delBucket(b); }}><Trash2 className="size-4" /></IconBtn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const crumbs = prefix.split("/").filter(Boolean);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <button onClick={() => setView("list")} title="Back to buckets" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-4" />
        </button>
        <HardDrive className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Storage</h1>
        <div className="ml-3 w-52">
          <Select value={bucketId} onValueChange={setBucketId}>
            <SelectTrigger><SelectValue placeholder="Select a bucket…" /></SelectTrigger>
            <SelectContent>{buckets.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {clip && (
            <div className="mr-1 flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary">
              {clip.op === "cut" ? <Scissors className="size-3.5" /> : <Copy className="size-3.5" />}
              <span>{clip.items.length} item{clip.items.length > 1 ? "s" : ""}</span>
              <button onClick={() => setClip(null)} title="Clear"><X className="size-3.5" /></button>
            </div>
          )}
          {clip && <Button variant="outline" size="sm" onClick={paste} disabled={loading}><ClipboardPaste className="size-4" /> Paste here</Button>}
          <Button variant="outline" size="icon" className="size-9" title="Refresh" onClick={list}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button>
          <Button variant="outline" size="icon" className="size-9" title="Edit connection"
            onClick={() => { setEditing(buckets.find((b) => b.id === bucketId) ?? null); setShowConfig(true); }}><Settings className="size-4" /></Button>
          <Button variant="outline" size="sm" disabled={!bucketId} onClick={createFolder}>
            <FolderPlus className="size-4" /> New folder
          </Button>
          <Button size="sm" disabled={!bucketId || progress !== null} onClick={upload}>
            {progress ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
          </Button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 border-b border-border px-5 py-2 text-sm">
        <button onClick={() => setPrefix("")} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <Home className="size-3.5" /> {buckets.find((b) => b.id === bucketId)?.bucket ?? "root"}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <button onClick={() => setPrefix(crumbs.slice(0, i + 1).join("/") + "/")} className="rounded px-1.5 py-0.5 hover:bg-accent">{c}</button>
          </span>
        ))}
      </div>

      {/* Bulk selection toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-5 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button variant="outline" size="sm" onClick={downloadSelected}><Download className="size-4" /> Download</Button>
          <Button variant="outline" size="sm" onClick={() => putClip("copy", selItems())}><Copy className="size-4" /> Copy</Button>
          <Button variant="outline" size="sm" onClick={() => putClip("cut", selItems())}><Scissors className="size-4" /> Cut</Button>
          <Button variant="outline" size="sm" onClick={() => removeItems(selItems())}><Trash2 className="size-4" /> Delete</Button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-muted-foreground hover:text-foreground">Clear</button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto" onContextMenu={(e) => openMenu(e, null)}>
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10">
            <div className="flex flex-col items-center gap-2 text-primary">
              <UploadCloud className="size-10" />
              <span className="font-medium">Drop files or folders to upload</span>
            </div>
          </div>
        )}
        {!listing || (listing.prefixes.length === 0 && listing.objects.filter((o) => o.key !== prefix).length === 0) ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{loading ? "Loading…" : "This folder is empty."}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-card text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-8 px-3 py-2">
                  <Checkbox checked={allSelected} onCheckedChange={(v) => setSelected(v ? new Set(allKeys) : new Set())} />
                </th>
                <Th>Name</Th><Th>Size</Th><Th>Modified</Th><Th> </Th>
              </tr>
            </thead>
            <tbody>
              {listing.prefixes.map((p) => {
                const item: Item = { key: p, isFolder: true, name: basename(p) };
                return (
                  <tr key={p} className="group cursor-pointer border-b border-border/60 hover:bg-accent"
                    onClick={() => setPrefix(p)} onContextMenu={(e) => openMenu(e, item)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(p)} onCheckedChange={() => toggleSel(p)} />
                    </td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <Folder className="size-4 shrink-0 text-primary" />
                        <span className="truncate font-medium">{item.name}/</span>
                      </span>
                    </Td>
                    <Td muted>—</Td><Td muted>—</Td>
                    <Td>
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                        <IconBtn title="Copy" onClick={(e) => { e.stopPropagation(); putClip("copy", [item]); }}><Copy className="size-4" /></IconBtn>
                        <IconBtn title="Cut" onClick={(e) => { e.stopPropagation(); putClip("cut", [item]); }}><Scissors className="size-4" /></IconBtn>
                      </div>
                    </Td>
                  </tr>
                );
              })}
              {listing.objects.filter((o) => o.key !== prefix).map((o) => {
                const item: Item = { key: o.key, isFolder: false, name: o.key.slice(prefix.length) };
                return (
                  <tr key={o.key} className="group border-b border-border/60 hover:bg-accent" onContextMenu={(e) => openMenu(e, item)}>
                    <td className="px-3 py-2"><Checkbox checked={selected.has(o.key)} onCheckedChange={() => toggleSel(o.key)} /></td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.name}</span>
                      </span>
                    </Td>
                    <Td muted>{fmtSize(o.size)}</Td>
                    <Td muted>{fmtDate(o.last_modified)}</Td>
                    <Td>
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                        <IconBtn title="Download" onClick={() => download(item)}><Download className="size-4" /></IconBtn>
                        <IconBtn title="Copy pre-signed URL (1h)" onClick={() => copyUrl(o.key)}>
                          {copied === o.key ? <Check className="size-4 text-primary" /> : <Link2 className="size-4" />}
                        </IconBtn>
                        <IconBtn title="Delete" danger onClick={() => removeItems([item])}><Trash2 className="size-4" /></IconBtn>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Upload progress */}
      {progress && <ProgressBar p={progress} />}

      {/* Conflict resolution */}
      <Dialog open={conflict !== null} onOpenChange={(o) => { if (!o && conflict) { conflict.resolve(null); setConflict(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Some items already exist</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {conflict?.count} item{(conflict?.count ?? 0) > 1 ? "s" : ""} already exist at the destination. How do you want to proceed?
          </p>
          <DialogFooter className="!flex-col gap-2 sm:items-stretch">
            <Button onClick={() => { conflict?.resolve("overwrite"); setConflict(null); }}>Overwrite — replace conflicting files</Button>
            <Button variant="outline" onClick={() => { conflict?.resolve("skip"); setConflict(null); }}>Merge — keep existing, add new only</Button>
            <Button variant="outline" onClick={() => { conflict?.resolve("replace"); setConflict(null); }}>Replace — delete target folder first</Button>
            <Button variant="ghost" onClick={() => { conflict?.resolve(null); setConflict(null); }}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Context menu */}
      {menu && (
        <div className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg"
          style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 220) }}
          onClick={(e) => e.stopPropagation()}>
          {menu.item === null ? (
            <>
              <MenuItem icon={FolderPlus} onClick={() => { setMenu(null); createFolder(); }}>New folder</MenuItem>
              <MenuItem icon={Upload} onClick={() => { setMenu(null); upload(); }}>Upload files</MenuItem>
              {clip && <MenuItem icon={ClipboardPaste} onClick={() => { setMenu(null); paste(); }}>Paste here</MenuItem>}
            </>
          ) : (
            <>
              {menu.item.isFolder ? (
                <MenuItem icon={FolderOpen} onClick={() => { const k = (menu.item as Item).key; setMenu(null); setPrefix(k); }}>Open</MenuItem>
              ) : (
                <>
                  <MenuItem icon={Download} onClick={() => { const it = menu.item as Item; setMenu(null); download(it); }}>Download</MenuItem>
                  <MenuItem icon={Link2} onClick={() => { const k = (menu.item as Item).key; setMenu(null); copyUrl(k); }}>Copy URL (1h)</MenuItem>
                </>
              )}
              <MenuItem icon={Copy} onClick={() => { const it = menu.item as Item; setMenu(null); putClip("copy", [it]); }}>Copy</MenuItem>
              <MenuItem icon={Scissors} onClick={() => { const it = menu.item as Item; setMenu(null); putClip("cut", [it]); }}>Cut</MenuItem>
              <div className="my-1 h-px bg-border" />
              <MenuItem icon={Trash2} danger onClick={() => { const it = menu.item as Item; setMenu(null); removeItems([it]); }}>Delete</MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PRESETS: Record<string, { endpoint: string; region: string }> = {
  "AWS S3": { endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" },
  "Cloudflare R2": { endpoint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto" },
  "Google Cloud": { endpoint: "https://storage.googleapis.com", region: "auto" },
  "MinIO": { endpoint: "http://localhost:9000", region: "us-east-1" },
};

function ProgressBar({ p }: { p: Progress }) {
  const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  return (
    <div className="border-t border-border bg-card px-5 py-2.5">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="truncate text-muted-foreground">{p.file ? `Uploading ${basename(p.file)}` : "Uploading…"}</span>
        <span className="tabular-nums text-muted-foreground">{fmtSize(p.done)} / {fmtSize(p.total)} · {fmtSize(p.speed)}/s</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BucketForm({ bucket, onDone, onCancel }: { bucket: StorageBucket | null; onDone: () => void; onCancel?: () => void }) {
  const [name, setName] = useState(bucket?.name ?? "");
  const [endpoint, setEndpoint] = useState(bucket?.endpoint ?? PRESETS["AWS S3"].endpoint);
  const [region, setRegion] = useState(bucket?.region ?? "auto");
  const [bkt, setBkt] = useState(bucket?.bucket ?? "");
  const [accessKey, setAccessKey] = useState(bucket?.access_key ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    if (!bucket) return;
    if (!(await confirmDialog({ title: "Delete connection", message: `Remove "${bucket.name}"?`, confirmText: "Delete", danger: true }))) return;
    await api.deleteBucket(bucket.id);
    onDone();
  }
  async function save() {
    if (!name.trim() || !endpoint.trim() || !bkt.trim() || !accessKey.trim()) return setError("Name, endpoint, bucket and access key are required.");
    if (!bucket && !secretKey.trim()) return setError("Secret key is required.");
    setBusy(true); setError(null);
    const input: StorageBucketInput = {
      id: bucket?.id ?? null, name: name.trim(), endpoint: endpoint.trim(),
      region: region.trim() || "auto", access_key: accessKey.trim(), bucket: bkt.trim(),
      secret_key: secretKey.trim() || null,
    };
    try { await api.upsertBucket(input); onDone(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <HardDrive className="size-4 text-primary" />
        <h1 className="text-base font-semibold">{bucket ? "Edit connection" : "New storage connection"}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-lg space-y-4">
          <p className="text-sm text-muted-foreground">
            Works with any S3-compatible storage (AWS S3, Cloudflare R2, MinIO). Keys are stored in your OS keychain and are not synced to the cloud.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(PRESETS).map((p) => (
              <button key={p} onClick={() => { setEndpoint(PRESETS[p].endpoint); setRegion(PRESETS[p].region); }}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:text-foreground">{p}</button>
            ))}
          </div>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My R2 bucket" /></Field>
          <Field label="Endpoint"><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="font-mono text-xs" /></Field>
          <div className="flex gap-3">
            <div className="flex-1"><Field label="Bucket"><Input value={bkt} onChange={(e) => setBkt(e.target.value)} /></Field></div>
            <div className="w-32"><Field label="Region"><Input value={region} onChange={(e) => setRegion(e.target.value)} /></Field></div>
          </div>
          <Field label="Access Key ID"><Input value={accessKey} onChange={(e) => setAccessKey(e.target.value)} className="font-mono text-xs" /></Field>
          <Field label={bucket ? "Secret Access Key (leave blank to keep)" : "Secret Access Key"}>
            <Input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className="font-mono text-xs" />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between">
            <div>{bucket && <Button variant="outline" size="sm" onClick={del}>Delete</Button>}</div>
            <div className="flex gap-2">
              {onCancel && <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>}
              <Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs text-muted-foreground">{label}</label>{children}</div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}
function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <td className={cn("max-w-0 px-3 py-2", muted && "text-muted-foreground")}><div className="truncate">{children}</div></td>;
}
function IconBtn({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className={cn("rounded p-1.5 text-muted-foreground hover:bg-border hover:text-foreground", danger && "hover:text-destructive")}>
      {children}
    </button>
  );
}
function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ComponentType<{ className?: string }>; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-accent", danger ? "text-destructive" : "text-foreground")}>
      <Icon className="size-4 shrink-0" />{children}
    </button>
  );
}
