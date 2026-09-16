import { useEffect, useState } from "react";
import { copyText } from "../lib/clipboard";
import { Radar, Search, Loader2, Server, Copy, Plus, ScanLine, Router, Laptop } from "lucide-react";
import { api, LanDevice } from "../lib/ipc";
import { alertDialog } from "../lib/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const COMMON_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995,
  1723, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 27017,
];

const SERVICES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http",
  110: "pop3", 135: "msrpc", 139: "netbios", 143: "imap", 443: "https",
  445: "smb", 993: "imaps", 995: "pop3s", 1723: "pptp", 3306: "mysql",
  3389: "rdp", 5432: "postgres", 5900: "vnc", 6379: "redis", 8080: "http-alt",
  8443: "https-alt", 27017: "mongodb",
};

/** Phân tích chuỗi cổng: "22,80,443" và dải "1-1024" → mảng số (đã dedupe, giới hạn). */
function parsePorts(text: string): number[] {
  const set = new Set<number>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Math.max(1, +m[1]);
      const b = Math.min(65535, +m[2]);
      for (let p = a; p <= b && set.size < 20000; p++) set.add(p);
    } else if (/^\d+$/.test(part)) {
      const p = +part;
      if (p >= 1 && p <= 65535) set.add(p);
    }
  }
  return [...set];
}

type Mode = "lan" | "hosts" | "ports";

export function NetworkScanPage({ onAddHost }: { onAddHost: (address: string, port: number) => void }) {
  const [mode, setMode] = useState<Mode>("lan");
  const [cidr, setCidr] = useState("192.168.1.0/24");
  const [discoverPort, setDiscoverPort] = useState(22);
  const [target, setTarget] = useState("");
  const [portText, setPortText] = useState("common");
  const [busy, setBusy] = useState(false);
  const [foundHosts, setFoundHosts] = useState<string[] | null>(null);
  const [openPorts, setOpenPorts] = useState<number[] | null>(null);
  const [devices, setDevices] = useState<LanDevice[] | null>(null);
  const [devQ, setDevQ] = useState("");

  // Tự nhận subnet nội bộ để điền sẵn CIDR.
  useEffect(() => {
    api.localCidr().then((c) => { if (c) setCidr(c); }).catch(() => {});
  }, []);

  async function runLanScan() {
    if (!cidr.trim()) return;
    setBusy(true); setDevices(null);
    try {
      setDevices(await api.scanLan(cidr.trim()));
    } catch (e) {
      alertDialog({ title: "Scan failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runHostScan() {
    if (!cidr.trim()) return;
    setBusy(true); setFoundHosts(null);
    try {
      const hosts = await api.scanHosts(cidr.trim(), discoverPort);
      setFoundHosts(hosts);
    } catch (e) {
      alertDialog({ title: "Scan failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function runPortScan(tgt?: string) {
    const t = (tgt ?? target).trim();
    if (!t) return;
    const ports = portText.trim() === "common" ? COMMON_PORTS : parsePorts(portText);
    if (ports.length === 0) return alertDialog({ title: "No ports", message: "Enter ports like 22,80,443 or 1-1024 (or 'common')." });
    setBusy(true); setOpenPorts(null);
    try {
      const open = await api.scanPorts(t, ports);
      setOpenPorts(open);
    } catch (e) {
      alertDialog({ title: "Scan failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function toPortScan(ip: string) {
    setMode("ports");
    setTarget(ip);
    setOpenPorts(null);
    setPortText("common");
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Radar className="size-4 text-primary" />
        <h1 className="text-base font-semibold">Network Scan</h1>
        <div className="ml-4 flex rounded-lg border border-border p-0.5">
          <Tab active={mode === "lan"} onClick={() => setMode("lan")}>LAN devices</Tab>
          <Tab active={mode === "hosts"} onClick={() => setMode("hosts")}>Discover hosts</Tab>
          <Tab active={mode === "ports"} onClick={() => setMode("ports")}>Port scan</Tab>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl space-y-4">
          {mode === "lan" ? (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                <div className="flex-1 space-y-1" style={{ minWidth: 200 }}>
                  <label className="text-xs text-muted-foreground">Subnet (CIDR)</label>
                  <Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24"
                    onKeyDown={(e) => { if (e.key === "Enter") runLanScan(); }} />
                </div>
                <Button onClick={runLanScan} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  Scan
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Lists devices connected to your router (from the OS ARP table). Shows private IP + MAC,
                vendor guess, hostname; marks the router and this device. No root needed.
              </p>

              {devices && devices.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-input bg-card px-2.5 sm:max-w-sm">
                  <Search className="size-4 text-muted-foreground" />
                  <input value={devQ} onChange={(e) => setDevQ(e.target.value)} placeholder="Filter by IP, MAC, name…"
                    className="w-full bg-transparent py-1.5 text-sm outline-none" />
                </div>
              )}
              {devices && (() => {
                const s = devQ.trim().toLowerCase();
                const shown = s ? devices.filter((d) =>
                  d.ip.includes(s) || d.mac.toLowerCase().includes(s) ||
                  (d.vendor ?? "").toLowerCase().includes(s) || (d.hostname ?? "").toLowerCase().includes(s)) : devices;
                return (
                <Results title={`${shown.length}${s ? ` / ${devices.length}` : ""} device${devices.length === 1 ? "" : "s"} on the network`}>
                  {devices.length === 0 ? (
                    <Empty text="No devices found — try again (ARP cache may need a moment)." />
                  ) : shown.length === 0 ? (
                    <Empty text="No devices match your filter." />
                  ) : (
                    shown.map((d) => (
                      <div key={d.ip} className="flex items-center gap-3 px-3 py-2 hover:bg-accent">
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg",
                          d.is_gateway ? "bg-orange-500/15 text-orange-500" : "bg-primary/15 text-primary")}>
                          {d.is_gateway ? <Router className="size-4" /> : d.is_self ? <Laptop className="size-4" /> : <Server className="size-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">{d.ip}</span>
                            {d.is_gateway && <Badge className="bg-orange-500/15 text-orange-500">Router</Badge>}
                            {d.is_self && <Badge className="bg-primary/15 text-primary">This device</Badge>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[d.mac || null, d.vendor, d.hostname].filter(Boolean).join("  ·  ") || "—"}
                          </div>
                        </div>
                        <RowBtn title="Port scan this device" onClick={() => toPortScan(d.ip)}><ScanLine className="size-4" /></RowBtn>
                        <RowBtn title="Copy IP" onClick={() => copyText(d.ip)}><Copy className="size-4" /></RowBtn>
                        <Button size="sm" variant="outline" onClick={() => onAddHost(d.ip, 22)}>
                          <Plus className="size-4" /> Add host
                        </Button>
                      </div>
                    ))
                  )}
                </Results>
                );
              })()}
            </>
          ) : mode === "hosts" ? (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                <div className="flex-1 space-y-1" style={{ minWidth: 200 }}>
                  <label className="text-xs text-muted-foreground">Subnet (CIDR)</label>
                  <Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.1.0/24"
                    onKeyDown={(e) => { if (e.key === "Enter") runHostScan(); }} />
                </div>
                <div className="w-24 space-y-1">
                  <label className="text-xs text-muted-foreground">Probe port</label>
                  <Input type="number" value={discoverPort} onChange={(e) => setDiscoverPort(+e.target.value || 22)} />
                </div>
                <Button onClick={runHostScan} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  Scan
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Finds hosts whose port {discoverPort} is open (TCP connect — no root needed). Max /16.
              </p>

              {foundHosts && (
                <Results title={`${foundHosts.length} host${foundHosts.length === 1 ? "" : "s"} found`}>
                  {foundHosts.length === 0 ? (
                    <Empty text="No hosts responded on that port." />
                  ) : (
                    foundHosts.map((ip) => (
                      <div key={ip} className="flex items-center gap-3 px-3 py-2 hover:bg-accent">
                        <Server className="size-4 shrink-0 text-primary" />
                        <span className="flex-1 font-mono text-sm">{ip}</span>
                        <RowBtn title="Port scan this host" onClick={() => toPortScan(ip)}><ScanLine className="size-4" /></RowBtn>
                        <RowBtn title="Copy IP" onClick={() => copyText(ip)}><Copy className="size-4" /></RowBtn>
                        <Button size="sm" variant="outline" onClick={() => onAddHost(ip, discoverPort)}>
                          <Plus className="size-4" /> Add host
                        </Button>
                      </div>
                    ))
                  )}
                </Results>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                <div className="flex-1 space-y-1" style={{ minWidth: 180 }}>
                  <label className="text-xs text-muted-foreground">Target (IP or host)</label>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="192.168.1.10"
                    onKeyDown={(e) => { if (e.key === "Enter") runPortScan(); }} />
                </div>
                <div className="flex-1 space-y-1" style={{ minWidth: 180 }}>
                  <label className="text-xs text-muted-foreground">Ports (or "common", "1-1024")</label>
                  <Input value={portText} onChange={(e) => setPortText(e.target.value)} placeholder="common" />
                </div>
                <Button onClick={() => runPortScan()} disabled={busy || !target.trim()}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  Scan
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {["common", "1-1024", "22,80,443,3306,5432,6379"].map((p) => (
                  <button key={p} onClick={() => setPortText(p)}
                    className={cn("rounded-full border px-3 py-1 text-xs",
                      portText === p ? "border-primary bg-primary/15 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground")}>
                    {p}
                  </button>
                ))}
              </div>

              {openPorts && (
                <Results title={`${openPorts.length} open port${openPorts.length === 1 ? "" : "s"} on ${target}`}>
                  {openPorts.length === 0 ? (
                    <Empty text="No open ports found." />
                  ) : (
                    openPorts.map((p) => (
                      <div key={p} className="flex items-center gap-3 px-3 py-2 hover:bg-accent">
                        <span className="w-16 font-mono text-sm text-primary">{p}</span>
                        <span className="flex-1 text-sm text-muted-foreground">{SERVICES[p] ?? "—"}</span>
                        {p === 22 && (
                          <Button size="sm" variant="outline" onClick={() => onAddHost(target.trim(), 22)}>
                            <Plus className="size-4" /> Add SSH host
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </Results>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn("rounded-md px-3 py-1 text-sm transition-colors",
        active ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
      {children}
    </button>
  );
}

function Results({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border bg-card px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-sm text-muted-foreground">{text}</div>;
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", className)}>{children}</span>;
}

function RowBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1.5 text-muted-foreground hover:bg-border hover:text-foreground">
      {children}
    </button>
  );
}
