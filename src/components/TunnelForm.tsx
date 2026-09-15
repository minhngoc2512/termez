import { useEffect, useState } from "react";
import { api, Tunnel, TunnelInput } from "../lib/ipc";
import { useStore } from "../store";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  open: boolean;
  tunnel?: Tunnel | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function TunnelForm({ open, tunnel, onOpenChange, onSaved }: Props) {
  const hosts = useStore((s) => s.hosts);

  const [name, setName] = useState("");
  const [hostId, setHostId] = useState("");
  const [kind, setKind] = useState("local");
  const [localPort, setLocalPort] = useState<number | "">(8080);
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState<number | "">(80);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(tunnel?.name ?? "");
    setHostId(tunnel?.host_id ?? hosts[0]?.id ?? "");
    setKind(tunnel?.kind ?? "local");
    setLocalPort(tunnel?.local_port ?? 8080);
    setRemoteHost(tunnel?.remote_host ?? "127.0.0.1");
    setRemotePort(tunnel?.remote_port ?? 80);
    setError(null);
  }, [open, tunnel, hosts]);

  async function save() {
    if (!hostId) {
      setError("Choose a host first.");
      return;
    }
    setSaving(true);
    setError(null);
    const input: TunnelInput = {
      id: tunnel?.id ?? null,
      name: name.trim() || `${kind}:${localPort}`,
      host_id: hostId,
      kind,
      local_port: Number(localPort) || 0,
      remote_host: kind === "local" ? remoteHost.trim() || null : null,
      remote_port: kind === "local" ? Number(remotePort) || null : null,
    };
    try {
      await api.upsertTunnel(input);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tunnel ? "Edit tunnel" : "New tunnel"}</DialogTitle>
        </DialogHeader>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tunnel" />
        </Field>

        <Field label="Through host">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Select a host" /></SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.label} ({h.username}@{h.address})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Type">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local (-L)  ·  forward a local port to a remote target</SelectItem>
              <SelectItem value="dynamic">Dynamic (-D)  ·  SOCKS5 proxy</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label={kind === "dynamic" ? "SOCKS local port" : "Local port"}>
          <Input
            type="number"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </Field>

        {kind === "local" && (
          <div className="flex gap-3">
            <div className="flex-[3] space-y-1">
              <label className="text-xs text-muted-foreground">Remote host (from server)</label>
              <Input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="127.0.0.1" />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">Remote port</label>
              <Input
                type="number"
                value={remotePort}
                onChange={(e) => setRemotePort(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
