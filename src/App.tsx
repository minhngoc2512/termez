import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, Columns2, FolderOpen, Home, Code2, ShieldCheck } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { FeatureNav, Section } from "./components/FeatureNav";
import { HostsPage } from "./components/HostsPage";
import { HostSearch } from "./components/HostSearch";
import { HostForm } from "./components/HostForm";
import { KeyManager } from "./components/KeyManager";
import { SyncDialog } from "./components/SyncDialog";
import { TerminalView } from "./components/TerminalView";
import { SftpView } from "./components/SftpView";
import { ForwardingView } from "./components/ForwardingView";
import { VaultView } from "./components/VaultView";
import { KeychainPage, SettingsPage, Placeholder } from "./components/SectionPages";
import { NetworkScanPage } from "./components/NetworkScanPage";
import { CloudflareDnsPage } from "./components/CloudflareDnsPage";
import { PanelTab } from "./components/PanelTab";
import { DialogHost } from "./components/DialogHost";
import { LockScreen } from "./components/LockScreen";
import { hostActions } from "./lib/hostActions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "./store";
import { Host } from "./lib/ipc";

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
};

const tabComponents = { info: PanelTab };
const EmptyWatermark = () => null;

export default function App() {
  const refresh = useStore((s) => s.refresh);
  const broadcast = useStore((s) => s.broadcast);
  const toggleBroadcast = useStore((s) => s.toggleBroadcast);
  const locked = useStore((s) => s.locked);
  const lockEnabled = useStore((s) => s.lockEnabled);
  const lockTimeout = useStore((s) => s.lockTimeout);
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
              {section === "hosts" && <HostsPage onOpen={openHost} onAdd={openAdd} onEdit={openEdit} />}
              {section === "keychain" && <KeychainPage onManage={() => setKeysOpen(true)} />}
              {section === "forwarding" && <ForwardingView />}
              {section === "passwords" && <VaultView />}
              {section === "settings" && <SettingsPage onSync={() => setSyncOpen(true)} />}
              {section === "snippets" && (
                <Placeholder icon={Code2} title="Snippets" note="Saved commands are coming soon." />
              )}
              {section === "known" && (
                <Placeholder icon={ShieldCheck} title="Known Hosts" note="Host key management is coming soon." />
              )}
              {section === "scan" && <NetworkScanPage onAddHost={addHostFromScan} />}
              {section === "dns" && <CloudflareDnsPage />}
            </div>
          )}
        </main>
      </div>

      <HostForm open={formOpen} host={editing} preset={preset} onOpenChange={setFormOpen} onSaved={refresh} />
      <KeyManager open={keysOpen} onOpenChange={setKeysOpen} />
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} />
      <DialogHost />
    </div>
  );
}
