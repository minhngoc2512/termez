import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, PlugZap } from "lucide-react";
import { api, DbConnection, DbConnectionInput, DbKind, DbSslMode } from "../../lib/ipc";
import { useStore } from "../../store";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const DB_KINDS: { id: DbKind; label: string; port: number }[] = [
  { id: "mysql", label: "MySQL", port: 3306 },
  { id: "mariadb", label: "MariaDB", port: 3306 },
  { id: "postgres", label: "PostgreSQL", port: 5432 },
];

const SSL_MODES: { id: DbSslMode; label: string }[] = [
  { id: "prefer", label: "Prefer — TLS if available" },
  { id: "require", label: "Require — TLS, don't verify certificate" },
  { id: "verify", label: "Verify — TLS + trusted certificate" },
  { id: "disable", label: "Disable — plain connection" },
];

const NONE = "__none__";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

interface Props {
  open: boolean;
  conn: DbConnection | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function DbConnectionForm({ open, conn, onOpenChange, onSaved }: Props) {
  const hosts = useStore((s) => s.hosts);
  const [kind, setKind] = useState<DbKind>("mysql");
  const [name, setName] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState<number | "">(3306);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [database, setDatabase] = useState("");
  const [sshHostId, setSshHostId] = useState<string | null>(null);
  const [sslMode, setSslMode] = useState<DbSslMode>("prefer");
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(conn?.kind ?? "mysql");
    setName(conn?.name ?? "");
    setHost(conn?.host ?? "127.0.0.1");
    setPort(conn?.port ?? 3306);
    setUsername(conn?.username ?? "root");
    setPassword("");
    setShowPw(false);
    setDatabase(conn?.database ?? "");
    setSshHostId(conn?.ssh_host_id ?? null);
    setSslMode(conn?.ssl_mode ?? "prefer");
    setReadOnly(conn?.read_only ?? false);
    setError(null);
    setTestMsg(null);
  }, [open, conn]);

  function changeKind(k: DbKind) {
    const prev = DB_KINDS.find((x) => x.id === kind);
    const next = DB_KINDS.find((x) => x.id === k)!;
    // Đổi loại → đổi cổng/user mặc định nếu người dùng chưa sửa.
    if (port === "" || port === prev?.port) setPort(next.port);
    if (k === "postgres" && username === "root") setUsername("postgres");
    if (k !== "postgres" && username === "postgres") setUsername("root");
    setKind(k);
  }

  function buildInput(): DbConnectionInput {
    const label = DB_KINDS.find((x) => x.id === kind)!.label;
    return {
      id: conn?.id ?? null,
      name: name.trim() || `${label} ${host.trim()}`,
      kind,
      host: host.trim(),
      port: Number(port) || DB_KINDS.find((x) => x.id === kind)!.port,
      username: username.trim(),
      password: password || null,
      database: database.trim() || null,
      ssh_host_id: sshHostId,
      ssl_mode: sslMode,
      read_only: readOnly,
      options: conn?.options ?? null,
    };
  }

  async function test() {
    setTesting(true);
    setTestMsg(null);
    try {
      const v = await api.dbTest(buildInput());
      setTestMsg({ ok: true, text: `Connected — server ${v}` });
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!host.trim() || !username.trim()) {
      setError("Host and user are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.upsertDbConnection(buildInput());
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const via = sshHostId ? hosts.find((h) => h.id === sshHostId) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{conn ? "Edit database connection" : "New database connection"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="Type">
                <Select value={kind} onValueChange={(v) => changeKind(v as DbKind)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DB_KINDS.map((k) => (
                      <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex-[2]">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production DB" />
              </Field>
            </div>
          </div>

          <Field label="Connect through SSH (tunnel)">
            <Select value={sshHostId ?? NONE} onValueChange={(v) => setSshHostId(v === NONE ? null : v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>(direct connection)</SelectItem>
                {hosts.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.label} ({h.username}@{h.address})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="flex gap-3">
            <div className="flex-[3]">
              <Field label={via ? `Host (as seen from ${via.label})` : "Host"}>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Port">
                <Input type="number" value={port} onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))} />
              </Field>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <Field label="User">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Password">
                <div className="relative">
                  <Input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={conn ? "(unchanged)" : ""}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
            </div>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">🔒 Password is stored in the OS keychain, not in the database.</p>

          <Field label={kind === "postgres" ? "Database (default: postgres)" : "Default database (optional)"}>
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={kind === "postgres" ? "postgres" : ""} />
          </Field>

          <Field label="TLS / SSL">
            <Select value={sslMode} onValueChange={(v) => setSslMode(v as DbSslMode)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SSL_MODES.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={readOnly} onCheckedChange={(c) => setReadOnly(c === true)} />
            Read-only (the server rejects writes in this session)
          </label>

          {testMsg && (
            <div
              className={
                "flex items-start gap-2 rounded-md border px-3 py-2 text-sm " +
                (testMsg.ok ? "border-primary/40 bg-primary/10 text-primary" : "border-destructive/40 bg-destructive/10 text-destructive")
              }
            >
              {testMsg.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
              <span className="whitespace-pre-wrap break-words">{testMsg.text}</span>
            </div>
          )}
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={test} disabled={testing || !host.trim()}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Test connection
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
