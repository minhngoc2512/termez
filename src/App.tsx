import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, Columns2, FolderOpen, Cable, KeyRound } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomeView } from "./components/HomeView";
import { HostSearch } from "./components/HostSearch";
import { HostForm } from "./components/HostForm";
import { KeyManager } from "./components/KeyManager";
import { SyncDialog } from "./components/SyncDialog";
import { TerminalView } from "./components/TerminalView";
import { SftpView } from "./components/SftpView";
import { ForwardingView } from "./components/ForwardingView";
import { VaultView } from "./components/VaultView";
import { PanelTab } from "./components/PanelTab";
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
  forwarding: () => <ForwardingView />,
  vault: () => <VaultView />,
};

const tabComponents = { info: PanelTab };

const EmptyWatermark = () => null;

export default function App() {
  const refresh = useStore((s) => s.refresh);
  const broadcast = useStore((s) => s.broadcast);
  const toggleBroadcast = useStore((s) => s.toggleBroadcast);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [hasPanels, setHasPanels] = useState(false);
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    hostActions.open = openHost;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    const sync = () => setHasPanels(event.api.panels.length > 0);
    sync();
    event.api.onDidLayoutChange(sync);
  }

  function openHost(host: Host) {
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "terminal",
      tabComponent: "info",
      title: host.label,
      params: { hostId: host.id, theme: host.term_theme, fontSize: host.font_size },
    });
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
  }

  function openForwarding() {
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "forwarding",
      tabComponent: "info",
      title: "Port Forwarding",
    });
  }

  function openVault() {
    apiRef.current?.addPanel({
      id: crypto.randomUUID(),
      component: "vault",
      tabComponent: "info",
      title: "Passwords",
    });
  }

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(h: Host) {
    setEditing(h);
    setFormOpen(true);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          onAdd={openAdd}
          onEdit={openEdit}
          onKeys={() => setKeysOpen(true)}
          onOpen={openHost}
          onSync={() => setSyncOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card px-2.5 py-1.5">
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
            <Columns2 className="size-4" />
            Split
          </Button>
          <Button variant="outline" size="sm" onClick={openSftp} title="Open SFTP file browser">
            <FolderOpen className="size-4" />
            SFTP
          </Button>
          <Button variant="outline" size="sm" onClick={openForwarding} title="Port forwarding / tunnels">
            <Cable className="size-4" />
            Tunnels
          </Button>
          <Button variant="outline" size="sm" onClick={openVault} title="Password manager">
            <KeyRound className="size-4" />
            Passwords
          </Button>
          <HostSearch onOpen={openHost} />
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
          {!hasPanels && (
            <div className="absolute inset-0 z-10">
              <HomeView onOpen={openHost} onAdd={openAdd} />
            </div>
          )}
        </div>
        </main>
      </div>

      <HostForm
        open={formOpen}
        host={editing}
        onOpenChange={setFormOpen}
        onSaved={refresh}
      />
      <KeyManager open={keysOpen} onOpenChange={setKeysOpen} />
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} />
    </div>
  );
}
