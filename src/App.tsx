import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
  DockviewGroupPanel,
  SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, Columns2, FolderOpen, Home, Code2, X } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { FeatureNav, Section } from "./components/FeatureNav";
import { HostsPage } from "./components/HostsPage";
import { HostSearch } from "./components/HostSearch";
import { HostForm } from "./components/HostForm";
import { KeyManager } from "./components/KeyManager";
import { SyncDialog } from "./components/SyncDialog";
import { TerminalView } from "./components/TerminalView";
import { MonitorView } from "./components/MonitorView";
import { SftpView } from "./components/SftpView";
import { ForwardingView } from "./components/ForwardingView";
import { VaultView } from "./components/VaultView";
import { KeychainPage, SettingsPage, Placeholder } from "./components/SectionPages";
import { NetworkScanPage } from "./components/NetworkScanPage";
import { KnownHostsPage } from "./components/KnownHostsPage";
import { CloudflareDnsPage } from "./components/CloudflareDnsPage";
import { StoragePage } from "./components/StoragePage";
import { PanelTab } from "./components/PanelTab";
import * as terminalPool from "./lib/terminalPool";
import { DialogHost } from "./components/DialogHost";
import { LockScreen } from "./components/LockScreen";
import { hostActions } from "./lib/hostActions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import { applyAppTheme, useStore } from "./store";
import { api, Host } from "./lib/ipc";
import { SyncConflictDialog } from "./components/SyncConflictDialog";

const components = {
  terminal: (
    props: IDockviewPanelProps<{
      hostId: string;
      theme?: string | null;
      fontSize?: number | null;
    }>
  ) => (
    <TerminalView
      panelId={props.api.id}
      hostId={props.params.hostId}
      themeName={props.params.theme}
      fontSize={props.params.fontSize}
    />
  ),
  sftp: () => <SftpView />,
  monitor: (props: IDockviewPanelProps<{ hostId: string }>) => <MonitorView hostId={props.params.hostId} />,
};

const tabComponents = { info: PanelTab };
const EmptyWatermark = () => null;

export default function App() {
  const refresh = useStore((s) => s.refresh);
  const appTheme = useStore((s) => s.appTheme);
  const broadcast = useStore((s) => s.broadcast);
  const toggleBroadcast = useStore((s) => s.toggleBroadcast);
  const locked = useStore((s) => s.locked);
  const lockEnabled = useStore((s) => s.lockEnabled);
  const lockTimeout = useStore((s) => s.lockTimeout);
  const lockReauth = useStore((s) => s.lockReauth);
  const setLocked = useStore((s) => s.setLocked);
  const refreshLock = useStore((s) => s.refreshLock);

  const [section, setSection] = useState<Section>("hosts");
  const [showHome, setShowHome] = useState(true);
  const [booting, setBooting] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [preset, setPreset] = useState<{ address: string; port: number } | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  // Danh sách các phiên/tab đang mở (terminal, SFTP, monitor…) để quay lại nhanh.
  const [sessions, setSessions] = useState<{ id: string; title: string; hostId?: string }[]>([]);
  const [split, setSplit] = useState(false);
  // Mỗi TASK = một layout dockview riêng. Task 1 pane = host lẻ; task nhiều pane
  // (split) = "Workspace". Mở host = task mới; kéo task này vào task kia = gộp thành workspace.
  const [tasks, setTasks] = useState<{ id: string }[]>([]);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const taskLayouts = useRef<Map<string, SerializedDockview>>(new Map());
  const switching = useRef(false); // chặn release phiên khi clear/fromJSON lúc chuyển task
  const taskSeq = useRef(0);
  const apiRef = useRef<DockviewApi | null>(null);
  // Nếu cửa sổ được mở bằng "Duplicate in a new window" → tự mở terminal host này.
  const dupRef = useRef<string | null>(
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("dup") : null
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Mở host đang chờ (từ tham số ?dup=) khi đã sẵn sàng: hết boot, mở khóa,
  // dockview đã tạo, và danh sách host đã nạp.
  function maybeOpenDup() {
    const id = dupRef.current;
    if (!id || !apiRef.current) return;
    const host = useStore.getState().hosts.find((h) => h.id === id);
    if (!host) return;
    dupRef.current = null;
    openHost(host);
  }

  // Theme "system": cập nhật khi OS đổi sáng/tối.
  useEffect(() => {
    if (appTheme !== "system") return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: light)");
    } catch {
      return;
    }
    const handler = () => applyAppTheme("system");
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, [appTheme]);

  // Auto-pull data mới nhất từ cloud: lúc khởi động + mỗi 2 phút. Refresh khi có pull.
  useEffect(() => {
    let un: Promise<() => void> | undefined;
    try {
      un = listen("sync:pulled", () => refresh());
    } catch { /* ngoài Tauri */ }
    api.syncAutoPull().catch(() => {});
    const iv = window.setInterval(() => { api.syncAutoPull().catch(() => {}); }, 120_000);
    return () => { window.clearInterval(iv); un?.then((f) => f()).catch(() => {}); };
  }, [refresh]);

  // Kiểm tra trạng thái khóa lúc khởi động — nếu bật thì khóa ngay (không lộ dữ liệu).
  useEffect(() => {
    (async () => {
      await refreshLock();
      if (useStore.getState().lockEnabled) setLocked(true);
      setBooting(false);
    })();
  }, [refreshLock, setLocked]);

  // Tự khóa khi không hoạt động (nếu bật timeout).
  useEffect(() => {
    if (locked || !lockEnabled || lockTimeout <= 0) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    const iv = window.setInterval(() => {
      if (Date.now() - last >= lockTimeout * 60_000) setLocked(true);
    }, 5000);
    return () => {
      evs.forEach((ev) => window.removeEventListener(ev, bump));
      window.clearInterval(iv);
    };
  }, [locked, lockEnabled, lockTimeout, setLocked]);

  // Buộc xác thực lại sau N phút kể từ lúc mở khóa (kể cả đang dùng).
  useEffect(() => {
    if (locked || !lockEnabled || lockReauth <= 0) return;
    const t = window.setTimeout(() => setLocked(true), lockReauth * 60_000);
    return () => window.clearTimeout(t);
  }, [locked, lockEnabled, lockReauth, setLocked]);

  useEffect(() => {
    hostActions.open = openHost;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Host list nạp xong sau khi dockview sẵn sàng → thử mở host đang chờ (?dup=).
  const hosts = useStore((s) => s.hosts);
  useEffect(() => {
    if (!locked && !booting) maybeOpenDup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts, locked, booting]);

  // Task đang mở hết pane (đóng pane cuối / phiên thoát) → bỏ task, chuyển task khác hoặc về Home.
  useEffect(() => {
    if (switching.current || activeTask === null || sessions.length > 0) return;
    const remaining = tasks.filter((t) => t.id !== activeTask);
    taskLayouts.current.delete(activeTask);
    setTasks(remaining);
    if (remaining.length) {
      loadLayout(remaining[0].id);
      setActiveTask(remaining[0].id);
    } else {
      setActiveTask(null);
      setShowHome(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  function syncSessions(api: DockviewApi) {
    setSessions(
      api.panels.map((p) => ({
        id: p.id,
        title: p.title || "shell",
        hostId: (p.params as { hostId?: string } | undefined)?.hostId,
      }))
    );
  }

  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    event.api.onDidLayoutChange(() => {
      syncSessions(event.api);
      // Chia nhiều pane → hiện header từng pane (tên host + nút đóng).
      setSplit(event.api.groups.length > 1);
      // Đóng terminal cuối cùng → quay lại màn Home (bỏ qua khi đang chuyển workspace).
      if (!switching.current && event.api.panels.length === 0) setShowHome(true);
    });
    // Panel bị đóng hẳn → ngắt phiên. Nhưng KHÔNG release khi đang chuyển
    // workspace (clear/fromJSON cũng bắn sự kiện này) — pool phải giữ phiên sống.
    event.api.onDidRemovePanel((e) => { if (!switching.current) terminalPool.release(e.id); });
    // Cho phép kéo tab từ TaskBar (drag ngoài) → dockview mới hiện overlay chia màn hình.
    // Lúc dragover không đọc được getData nên nhận diện qua dataTransfer.types.
    event.api.onUnhandledDragOver((e) => {
      const dt = (e.nativeEvent as DragEvent).dataTransfer;
      if (dt && Array.from(dt.types).includes("termez/task")) e.accept();
    });
    // Kéo một task thả vào cạnh view hiện tại → gộp task đó vào task đang mở (workspace).
    event.api.onDidDrop((e) => {
      const id = (e.nativeEvent as DragEvent).dataTransfer?.getData("termez/task");
      if (!id || !e.group) return;
      mergeTaskIntoActive(id, e.group, e.position);
    });
    syncSessions(event.api);
    maybeOpenDup();
  }

  // ----- Tasks (mỗi task = một layout dockview) -----
  function saveActiveLayout() {
    const api = apiRef.current;
    if (api && activeTask) taskLayouts.current.set(activeTask, api.toJSON());
  }
  function loadLayout(id: string) {
    const api = apiRef.current;
    if (!api) return;
    switching.current = true; // chặn release phiên khi thay layout
    api.clear();
    const layout = taskLayouts.current.get(id);
    if (layout && Object.keys(layout.panels).length > 0) {
      try {
        api.fromJSON(layout);
      } catch {
        /* layout hỏng → task trống */
      }
    }
    switching.current = false;
  }
  // Mở nội dung mới trong một TASK riêng (không gộp vào task hiện tại).
  function openInNewTask(add: () => void) {
    saveActiveLayout();
    switching.current = true;
    apiRef.current?.clear();
    switching.current = false;
    add();
    taskSeq.current += 1;
    const id = `t-${taskSeq.current}`;
    setTasks((t) => [...t, { id }]);
    setActiveTask(id);
    setShowHome(false);
  }
  function switchTask(id: string) {
    if (id === activeTask) { setShowHome(false); return; }
    saveActiveLayout();
    loadLayout(id);
    setActiveTask(id);
    setShowHome(false);
  }
  function closeTask(id: string) {
    const panelIds =
      id === activeTask
        ? apiRef.current?.panels.map((p) => p.id) ?? []
        : Object.keys(taskLayouts.current.get(id)?.panels ?? {});
    panelIds.forEach((pid) => terminalPool.release(pid));
    taskLayouts.current.delete(id);

    const remaining = tasks.filter((t) => t.id !== id);
    if (id === activeTask) {
      const next = remaining[0];
      if (next) {
        loadLayout(next.id);
        setActiveTask(next.id);
      } else {
        switching.current = true;
        apiRef.current?.clear();
        switching.current = false;
        setActiveTask(null);
        setShowHome(true);
      }
    }
    setTasks(remaining);
  }
  // Kéo một task (host lẻ / workspace) thả vào cạnh view hiện tại → gộp panes của
  // nó vào task đang mở, tạo/mở rộng thành workspace. Task nguồn biến mất.
  function mergeTaskIntoActive(sourceId: string, group: DockviewGroupPanel, position: string) {
    if (sourceId === activeTask) return;
    const api = apiRef.current;
    const layout = taskLayouts.current.get(sourceId);
    if (!api || !layout) return;
    const dir = ({ top: "above", bottom: "below", left: "left", right: "right", center: "within" } as const)[
      position as "top" | "bottom" | "left" | "right" | "center"
    ] ?? "right";
    const panes = Object.values(layout.panels) as {
      id: string; contentComponent?: string; title?: string; params?: Record<string, unknown>;
    }[];
    panes.forEach((p, i) => {
      api.addPanel({
        id: p.id,
        component: p.contentComponent || "terminal",
        tabComponent: "info",
        title: p.title || "shell",
        params: (p.params ?? {}) as Record<string, unknown>,
        position: i === 0 ? { referenceGroup: group, direction: dir } : undefined,
      });
    });
    taskLayouts.current.delete(sourceId);
    setTasks((t) => t.filter((x) => x.id !== sourceId));
  }

  function selectSection(s: Section) {
    if (s === "sftp") {
      openSftp();
      return;
    }
    setSection(s);
    setShowHome(true);
  }

  function openHost(host: Host) {
    // Mỗi host mở ra là một TASK riêng.
    openInNewTask(() =>
      apiRef.current?.addPanel({
        id: crypto.randomUUID(),
        component: "terminal",
        tabComponent: "info",
        title: host.label,
        params: { hostId: host.id, theme: host.term_theme, fontSize: host.font_size },
      })
    );
  }

  function splitActive() {
    const api = apiRef.current;
    if (!api?.activePanel) return;
    const active = api.activePanel;
    if (!(active.params as { hostId?: string } | undefined)?.hostId) return;
    api.addPanel({
      id: crypto.randomUUID(),
      component: "terminal",
      tabComponent: "info",
      title: active.title || "shell",
      params: active.params,
      position: { referencePanel: active.id, direction: "right" },
    });
  }

  function openMonitor(host: Host) {
    openInNewTask(() =>
      apiRef.current?.addPanel({
        id: crypto.randomUUID(),
        component: "monitor",
        tabComponent: "info",
        title: `${host.label} · Monitor`,
        params: { hostId: host.id },
      })
    );
  }

  function openSftp() {
    openInNewTask(() =>
      apiRef.current?.addPanel({
        id: crypto.randomUUID(),
        component: "sftp",
        tabComponent: "info",
        title: "SFTP",
      })
    );
  }

  function openAdd() {
    setEditing(null);
    setPreset(null);
    setFormOpen(true);
  }
  function openEdit(h: Host) {
    setEditing(h);
    setPreset(null);
    setFormOpen(true);
  }
  function addHostFromScan(address: string, port: number) {
    setEditing(null);
    setPreset({ address, port });
    setFormOpen(true);
  }

  if (booting) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="flex flex-1 items-center justify-center text-2xl font-semibold text-muted-foreground">⌘ Termez</div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <LockScreen onUnlock={() => setLocked(false)} />
      </div>
    );
  }

  // Tên hiển thị của từng task: 1 pane → tên host; nhiều pane → "Workspace N".
  let wsNum = 0;
  const taskDisplay = tasks.map((t) => {
    const panes =
      t.id === activeTask
        ? sessions.map((s) => s.title)
        : Object.values(taskLayouts.current.get(t.id)?.panels ?? {}).map(
            (p) => (p as { title?: string }).title || "shell"
          );
    let name: string;
    let isWs = false;
    if (panes.length <= 1) name = panes[0] ?? "Empty";
    else {
      wsNum += 1;
      name = `Workspace ${wsNum}`;
      isWs = true;
    }
    return { id: t.id, name, isWs };
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar
        onToggleNav={() => setShowHome((v) => !v)}
        onLock={lockEnabled ? () => setLocked(true) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        {showHome && (
          <FeatureNav
            section={section}
            onSelect={selectSection}
            onSync={() => setSyncOpen(true)}
            sessions={taskDisplay.map((t) => ({ id: t.id, title: t.name }))}
            activeSession={activeTask}
            onOpenSession={switchTask}
          />
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Terminal workspace (dockview) — luôn mounted để giữ phiên sống */}
          <div className="absolute inset-0 flex flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-card px-2.5 py-1.5">
              <Button variant="outline" size="sm" onClick={() => setShowHome(true)} title="Back to menu">
                <Home className="size-4" /> Menu
              </Button>
              <div className="mx-1 h-5 w-px bg-border" />
              <Button
                variant={broadcast ? "destructive" : "outline"}
                size="sm"
                onClick={toggleBroadcast}
                title="Type once, send to ALL open panes"
              >
                <Radio className="size-4" />
                Broadcast {broadcast ? "ON" : "OFF"}
              </Button>
              <Button variant="outline" size="sm" onClick={splitActive} title="Open another shell of the active server">
                <Columns2 className="size-4" /> Split
              </Button>
              <Button variant="outline" size="sm" onClick={openSftp} title="Open SFTP file browser">
                <FolderOpen className="size-4" /> SFTP
              </Button>
              <div className="ml-auto">
                <HostSearch onOpen={openHost} />
              </div>
            </div>
            {/* Thanh TASK (cố định): host lẻ + Workspace (split). Kéo một task thả
                vào cạnh view → gộp thành workspace. */}
            {taskDisplay.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border bg-sidebar px-2 py-1.5">
                {taskDisplay.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("termez/task", t.id); e.dataTransfer.effectAllowed = "move"; }}
                    onClick={() => switchTask(t.id)}
                    onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTask(t.id); } }}
                    title={t.name}
                    className={cn(
                      "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1 text-[13px] transition-colors",
                      t.id === activeTask
                        ? "border-border bg-card text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {t.isWs
                      ? <Columns2 className="size-3.5 shrink-0 text-primary" />
                      : <span className={cn("size-1.5 shrink-0 rounded-full", t.id === activeTask ? "bg-primary" : "bg-muted-foreground/40")} />}
                    <span className="max-w-[170px] truncate">{t.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTask(t.id); }}
                      title="Close"
                      className="flex size-4 items-center justify-center rounded text-muted-foreground/70 hover:bg-border hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <DockviewReact
                className={cn(
                  "dockview-theme-abyss absolute inset-0",
                  split && "dv-panes",
                  broadcast && "ring-2 ring-inset ring-destructive"
                )}
                components={components}
                tabComponents={tabComponents}
                watermarkComponent={EmptyWatermark}
                onReady={onReady}
              />
            </div>
          </div>

          {/* Feature pages — phủ lên workspace khi ở Home */}
          {showHome && (
            <div className="absolute inset-0 z-10 bg-background">
              {section === "hosts" && <HostsPage onOpen={openHost} onAdd={openAdd} onEdit={openEdit} onMonitor={openMonitor} />}
              {section === "keychain" && <KeychainPage onManage={() => setKeysOpen(true)} />}
              {section === "forwarding" && <ForwardingView />}
              {section === "passwords" && <VaultView />}
              {section === "settings" && <SettingsPage onSync={() => setSyncOpen(true)} />}
              {section === "snippets" && (
                <Placeholder icon={Code2} title="Snippets" note="Saved commands are coming soon." />
              )}
              {section === "known" && <KnownHostsPage />}
              {section === "scan" && <NetworkScanPage onAddHost={addHostFromScan} />}
              {section === "dns" && <CloudflareDnsPage />}
              {section === "storage" && <StoragePage />}
            </div>
          )}
        </main>
      </div>

      <HostForm open={formOpen} host={editing} preset={preset} onOpenChange={setFormOpen} onSaved={refresh} />
      <KeyManager open={keysOpen} onOpenChange={setKeysOpen} />
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} />
      <SyncConflictDialog />
      <DialogHost />
    </div>
  );
}
