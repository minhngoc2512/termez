import { useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { api, joinPath, SftpProgress } from "../lib/ipc";
import { alertDialog } from "../lib/dialogs";
import { useStore } from "../store";
import { DragPayload, FilePane, PaneState } from "./FilePane";

interface Job {
  name: string;
  transferred: number;
  total: number;
  status: "running" | "done" | "error";
  error?: string;
}

export function SftpView() {
  const hosts = useStore((s) => s.hosts);
  const left = useRef<PaneState>({ endpoint: "local", path: "", selected: null });
  const right = useRef<PaneState>({ endpoint: "local", path: "", selected: null });
  const [reloadL, setReloadL] = useState(0);
  const [reloadR, setReloadR] = useState(0);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const jobSide = useRef<Record<string, "left" | "right">>({});

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    (async () => {
      unlisteners.push(
        await listen<SftpProgress>("sftp:progress", (e) => {
          const { id, transferred, total } = e.payload;
          setJobs((j) => (j[id] ? { ...j, [id]: { ...j[id], transferred, total } } : j));
        })
      );
      unlisteners.push(
        await listen<{ id: string }>("sftp:transfer-done", (e) => {
          const id = e.payload.id;
          setJobs((j) => (j[id] ? { ...j, [id]: { ...j[id], status: "done" } } : j));
          if (jobSide.current[id] === "left") setReloadL((n) => n + 1);
          else setReloadR((n) => n + 1);
          setTimeout(() => setJobs((j) => {
            const n = { ...j };
            delete n[id];
            return n;
          }), 2500);
        })
      );
      unlisteners.push(
        await listen<{ id: string; error: string }>("sftp:transfer-error", (e) => {
          const { id, error } = e.payload;
          setJobs((j) => (j[id] ? { ...j, [id]: { ...j[id], status: "error", error } } : j));
        })
      );
    })();
    return () => unlisteners.forEach((u) => u());
  }, []);

  async function runTransfer(
    srcEndpoint: string,
    srcPath: string,
    name: string,
    isDir: boolean,
    size: number,
    dstEndpoint: string,
    dstPath: string,
    reloadSide: "left" | "right"
  ) {
    if (isDir) {
      alertDialog({ title: "Not supported", message: "For now only files can be transferred (folders not supported yet)." });
      return;
    }
    if (srcEndpoint === dstEndpoint && srcPath === dstPath) return;
    try {
      const jobId = await api.sftpTransfer(srcEndpoint, joinPath(srcPath, name), dstEndpoint, joinPath(dstPath, name));
      jobSide.current[jobId] = reloadSide;
      setJobs((j) => ({ ...j, [jobId]: { name, transferred: 0, total: size, status: "running" } }));
    } catch (e) {
      alertDialog({ title: "Transfer failed", message: String(e) });
    }
  }

  function transfer(dir: "lr" | "rl") {
    const src = dir === "lr" ? left.current : right.current;
    const dst = dir === "lr" ? right.current : left.current;
    if (!src.selected) {
      alertDialog({ title: "No file selected", message: "Select a file in the source pane first." });
      return;
    }
    runTransfer(src.endpoint, src.path, src.selected.name, src.selected.is_dir, src.selected.size, dst.endpoint, dst.path, dir === "lr" ? "right" : "left");
  }

  function onDropTransfer(p: DragPayload, side: "left" | "right") {
    const dst = side === "left" ? left.current : right.current;
    runTransfer(p.endpoint, p.path, p.name, p.is_dir, p.size, dst.endpoint, dst.path, side);
  }

  const jobList = Object.entries(jobs);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <FilePane hosts={hosts} side="left" reloadKey={reloadL} onChange={(s) => (left.current = s)} onDropTransfer={onDropTransfer} />
        <div className="flex flex-col justify-center gap-2.5 border-x border-border bg-card px-2">
          <button
            className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-[--accent-dim]"
            title="Send to right"
            onClick={() => transfer("lr")}
          >
            <ArrowRight className="size-4" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-[--accent-dim]"
            title="Send to left"
            onClick={() => transfer("rl")}
          >
            <ArrowLeft className="size-4" />
          </button>
        </div>
        <FilePane hosts={hosts} side="right" reloadKey={reloadR} onChange={(s) => (right.current = s)} onDropTransfer={onDropTransfer} />
      </div>

      {jobList.length > 0 && (
        <div className="max-h-32 overflow-y-auto border-t border-border bg-card px-2.5 py-1.5">
          {jobList.map(([id, job]) => (
            <div key={id} className="flex items-center gap-2.5 py-1 text-[13px]">
              <span className="w-44 truncate">{job.name}</span>
              {job.status === "error" ? (
                <span className="flex-1 text-destructive">error: {job.error}</span>
              ) : (
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-150"
                    style={{ width: `${job.total ? Math.min(100, (job.transferred / job.total) * 100) : job.status === "done" ? 100 : 0}%` }}
                  />
                </div>
              )}
              <span className="w-11 text-right tabular-nums text-muted-foreground">
                {job.status === "done" ? "✓" : job.total ? `${Math.floor((job.transferred / job.total) * 100)}%` : "…"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
