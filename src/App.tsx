import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, Columns2, FolderOpen, Home, Code2 } from "lucide-react";
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
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    event.api.onDidLayoutChange(() => {
      // Đóng terminal cuối cùng → quay lại màn Home.
      if (event.api.panels.length === 0) setShowHome(true);
    });
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
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "terminal",
      tabComponent: "info",
      title: host.label,
      params: { hostId: host.id, theme: host.term_theme, fontSize: host.font_size },
    });
    setShowHome(false);
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
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "monitor",
      tabComponent: "info",
      title: `${host.label} · Monitor`,
      params: { hostId: host.id },
    });
    setShowHome(false);
  }

  function openSftp() {
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "sftp",
      tabComponent: "info",
      title: "SFTP",
    });
    setShowHome(false);
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar
        onToggleNav={() => setShowHome((v) => !v)}
        onLock={lockEnabled ? () => setLocked(true) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        {showHome && (
          <FeatureNav section={section} onSelect={selectSection} onSync={() => setSyncOpen(true)} />
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
            <div className="relative min-h-0 flex-1">
              <DockviewReact
                className={cn(
                  "dockview-theme-abyss absolute inset-0",
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
