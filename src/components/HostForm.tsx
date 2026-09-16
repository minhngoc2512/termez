import { useEffect, useState } from "react";
import { api, AuthType, Host, HostInput } from "../lib/ipc";
import { promptDialog, alertDialog } from "../lib/dialogs";
import { TERM_THEMES } from "../lib/themes";
import { useStore } from "../store";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Props {
  open: boolean;
  host?: Host | null;
  preset?: { address: string; port: number } | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const NONE = "__none__";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function HostForm({ open, host, preset, onOpenChange, onSaved }: Props) {
  const groups = useStore((s) => s.groups);
  const keys = useStore((s) => s.keys);
  const allHosts = useStore((s) => s.hosts);
  const refresh = useStore((s) => s.refresh);

  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [authType, setAuthType] = useState<AuthType>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyId, setKeyId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdv, setShowAdv] = useState(false);
  const [startup, setStartup] = useState("");
  const [keepalive, setKeepalive] = useState(false);
  const [termTheme, setTermTheme] = useState("");
  const [fontSize, setFontSize] = useState<number | "">("");
  const [proxyType, setProxyType] = useState("");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState<number | "">(1080);
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPass, setProxyPass] = useState("");
  const [jumpHostId, setJumpHostId] = useState<string | null>(null);
  const [proxyCommand, setProxyCommand] = useState("");

  // Nạp giá trị khi mở dialog.
  useEffect(() => {
    if (!open) return;
    setLabel(host?.label ?? (preset ? preset.address : ""));
    setAddress(host?.address ?? preset?.address ?? "");
    setPort(host?.port ?? preset?.port ?? 22);
    setUsername(host?.username ?? "root");
    setAuthType(host?.auth_type ?? "password");
    setPassword("");
    setKeyPath(host?.private_key_path ?? "");
    setKeyId(host?.key_id ?? null);
    setGroupId(host?.group_id ?? null);
    setStartup(host?.startup_snippet ?? "");
    setKeepalive(!!host?.keepalive);
    setTermTheme(host?.term_theme ?? "");
    setFontSize(host?.font_size ?? "");
    setProxyType(host?.proxy_type ?? "");
    setProxyHost(host?.proxy_host ?? "");
    setProxyPort(host?.proxy_port ?? 1080);
    setProxyUser(host?.proxy_username ?? "");
    setProxyPass("");
    setJumpHostId(host?.jump_host_id ?? null);
    setProxyCommand(host?.proxy_command ?? "");
    setError(null);
    setShowAdv(false);
  }, [open, host, preset]);

  async function createGroupInline() {
    const name = await promptDialog({ title: "New group", placeholder: "Group name", confirmText: "Create" });
    if (!name?.trim()) return;
    try {
      const g = await api.createGroup(name.trim(), null);
      await refresh();
      setGroupId(g.id);
    } catch (e) {
      alertDialog({ title: "Error", message: String(e) });
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const input: HostInput = {
      id: host?.id ?? null,
      group_id: groupId,
      label: label.trim() || address,
      address: address.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      auth_type: authType,
      password: authType === "password" ? password : null,
      private_key_path: authType === "key" ? keyPath || null : null,
      passphrase: null,
      key_id: authType === "key" ? keyId : null,
      startup_snippet: startup.trim() || null,
      keepalive,
      term_theme: termTheme || null,
      font_size: fontSize === "" ? null : Number(fontSize),
      proxy_type: proxyType || null,
      proxy_host: proxyType ? proxyHost.trim() || null : null,
      proxy_port: proxyType ? Number(proxyPort) || 1080 : null,
      proxy_username: proxyType ? proxyUser.trim() || null : null,
      proxy_password: proxyType ? proxyPass || null : null,
      jump_host_id: jumpHostId,
      proxy_command: proxyCommand.trim() || null,
    };
    try {
      await api.upsertHost(input);
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
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{host ? "Edit host" : "New host"}</DialogTitle>
        </DialogHeader>

        <Field label="Display name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my-server" />
        </Field>

        <div className="flex gap-3">
          <div className="flex-[3] space-y-1">
            <label className="text-xs text-muted-foreground">Address</label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="1.2.3.4 or host.com" />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">Port</label>
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
        </div>

        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field label="Authentication">
          <Select value={authType} onValueChange={(v) => setAuthType(v as AuthType)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="password">Password</SelectItem>
              <SelectItem value="key">SSH key</SelectItem>
              <SelectItem value="agent">SSH agent (not supported)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {authType === "password" && (
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={host ? "(leave blank to keep current)" : ""}
            />
            <p className="text-xs text-muted-foreground">
              🔒 Password is stored in the OS keychain, not in the database.
            </p>
          </Field>
        )}
        {authType === "key" && (
          <>
            <Field label="Choose a saved key">
              <Select value={keyId ?? NONE} onValueChange={(v) => setKeyId(v === NONE ? null : v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>(no managed key)</SelectItem>
                  {keys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name} — {k.algorithm}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="or key file path">
              <Input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
            </Field>
          </>
        )}

        <Field label="Group">
          <div className="flex gap-2">
            <Select value={groupId ?? NONE} onValueChange={(v) => setGroupId(v === NONE ? null : v)}>
              <SelectTrigger className="w-full flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>(no group)</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" onClick={createGroupInline}>+ Group</Button>
          </div>
        </Field>

        <button
          type="button"
          onClick={() => setShowAdv((v) => !v)}
          className="mt-1 flex items-center gap-1 border-t border-border pt-3 text-sm text-muted-foreground hover:text-foreground"
        >
          {showAdv ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Advanced (startup, keepalive, theme, proxy)
        </button>

        {showAdv && (
          <div className="space-y-3">
            <Field label="Startup snippet (command run on connect)">
              <Textarea rows={2} value={startup} onChange={(e) => setStartup(e.target.value)} placeholder="cd /var/www/html && ls -la" />
            </Field>

            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={keepalive} onCheckedChange={(c) => setKeepalive(c === true)} />
              Keep-alive (prevents idle disconnects)
            </label>

            <div className="flex gap-3">
              <div className="flex-[2] space-y-1">
                <label className="text-xs text-muted-foreground">Terminal theme</label>
                <Select value={termTheme || NONE} onValueChange={(v) => setTermTheme(v === NONE ? "" : v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>(default)</SelectItem>
                    {Object.entries(TERM_THEMES).map(([k, t]) => (
                      <SelectItem key={k} value={k}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground">Font size</label>
                <Input type="number" value={fontSize} onChange={(e) => setFontSize(e.target.value === "" ? "" : Number(e.target.value))} placeholder="14" />
              </div>
            </div>

            <Field label="Jump host (bastion / ProxyJump)">
              <Select value={jumpHostId ?? NONE} onValueChange={(v) => setJumpHostId(v === NONE ? null : v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>(direct, no jump)</SelectItem>
                  {allHosts
                    .filter((h) => h.id !== host?.id)
                    .map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.label} ({h.username}@{h.address})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="ProxyCommand (e.g. Cloudflare Tunnel)">
              <Input
                value={proxyCommand}
                onChange={(e) => setProxyCommand(e.target.value)}
                placeholder="cloudflared access ssh --hostname %h"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                If set, this command is spawned as the connection transport (overrides Proxy/Jump). %h/%p/%r → host/port/user.
              </p>
            </Field>

            <Field label="Proxy">
              <Select value={proxyType || "none"} onValueChange={(v) => setProxyType(v === "none" ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">(none)</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                  <SelectItem value="http">HTTP CONNECT</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {proxyType && (
              <>
                <div className="flex gap-3">
                  <div className="flex-[3] space-y-1">
                    <label className="text-xs text-muted-foreground">Proxy host</label>
                    <Input value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="127.0.0.1" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">Port</label>
                    <Input type="number" value={proxyPort} onChange={(e) => setProxyPort(e.target.value === "" ? "" : Number(e.target.value))} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">Proxy user (optional)</label>
                    <Input value={proxyUser} onChange={(e) => setProxyUser(e.target.value)} />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">Proxy pass</label>
                    <Input type="password" value={proxyPass} onChange={(e) => setProxyPass(e.target.value)} placeholder={host ? "(unchanged)" : ""} />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || !address}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
