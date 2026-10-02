import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, PlugZap, ChevronDown, ShieldCheck, FolderPlus } from "lucide-react";
import { api, DbConnection, DbConnectionInput, DbGroup, DbKind, DbSslMode } from "../../lib/ipc";
import { promptDialog, alertDialog } from "../../lib/dialogs";
import { useStore } from "../../store";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const DB_KINDS: { id: DbKind; label: string; port: number; user: string }[] = [
  { id: "mysql", label: "MySQL", port: 3306, user: "root" },
  { id: "mariadb", label: "MariaDB", port: 3306, user: "root" },
  { id: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  { id: "clickhouse", label: "ClickHouse", port: 8123, user: "default" },
  { id: "redis", label: "Redis", port: 6379, user: "" },
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
  groups: DbGroup[];
  /** Nhóm chọn sẵn khi tạo mới từ một nhóm. */
  defaultGroupId?: string | null;
  onGroupsChanged: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function DbConnectionForm({ open, conn, groups, defaultGroupId, onGroupsChanged, onOpenChange, onSaved }: Props) {
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
  const [groupId, setGroupId] = useState<string | null>(null);
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
    setGroupId(conn ? conn.group_id : (defaultGroupId ?? null));
    setError(null);
    setTestMsg(null);
  }, [open, conn, defaultGroupId]);

  function changeKind(k: DbKind) {
    const prev = DB_KINDS.find((x) => x.id === kind);
    const next = DB_KINDS.find((x) => x.id === k)!;
    // Đổi loại → đổi cổng/user mặc định nếu người dùng chưa sửa.
    if (port === "" || port === prev?.port) setPort(next.port);
    if (username === "" || username === prev?.user) setUsername(next.user);
    // Redis không có "prefer" (TLS phải bật/tắt rõ ràng).
    if (k === "redis" && sslMode === "prefer") setSslMode("disable");
    if (k === "redis" && !database) setDatabase("0");
    if (prev?.id === "redis" && database === "0") setDatabase("");
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
      group_id: groupId,
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
    if (!host.trim() || (kind !== "redis" && !username.trim())) {
      setError(kind === "redis" ? "Host is required." : "Host and user are required.");
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

  async function newGroup() {
    const n = await promptDialog({ title: "New group", placeholder: "Group name", confirmText: "Create" });
    if (!n?.trim()) return;
    try {
      const g = await api.upsertDbGroup(null, n.trim());
      await onGroupsChanged();
      setGroupId(g.id);
    } catch (e) {
      alertDialog({ title: "Error", message: String(e) });
    }
  }

  const via = sshHostId ? hosts.find((h) => h.id === sshHostId) : null;
  // Đủ thông tin để thử kết nối (lấy danh sách database).
  const canConnect = !!host.trim() && (kind === "redis" || !!username.trim());
  const connKey = JSON.stringify([kind, host.trim(), port, username.trim(), password, sshHostId, sslMode]);

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
              <Button type="button" variant="outline" onClick={newGroup}>
                <FolderPlus className="size-4" /> Group
              </Button>
            </div>
          </Field>

          {/* Read-only: đặt chỗ dễ thấy — bảo vệ DB production khỏi lệnh ghi. */}
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
              readOnly ? "border-amber-500/50 bg-amber-500/10" : "border-border hover:bg-accent/50"
            )}
          >
            <Checkbox className="mt-0.5" checked={readOnly} onCheckedChange={(c) => setReadOnly(c === true)} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className={cn("size-4", readOnly ? "text-amber-500" : "text-muted-foreground")} />
                Read-only connection
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {kind === "redis"
                  ? "Blocks every command the server flags as a write (SET, DEL, HSET, FLUSHDB…)."
                  : "Blocks INSERT, UPDATE, DELETE, DDL (CREATE/ALTER/DROP/TRUNCATE) and SET — only SELECT, SHOW, DESCRIBE and EXPLAIN run. The server session is read-only too."}
              </div>
            </div>
          </label>

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
              <Field label={kind === "redis" ? "User (ACL, optional)" : "User"}>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={kind === "redis" ? "default" : ""} />
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

          <Field
            label={
              kind === "postgres"
                ? "Database (default: postgres)"
                : kind === "redis"
                  ? "Database index (0–15)"
                  : "Default database (optional)"
            }
          >
            <DatabasePicker
              value={database}
              onChange={(v) => setDatabase(kind === "redis" ? v.replace(/\D/g, "") : v)}
              placeholder={kind === "postgres" ? "postgres" : kind === "redis" ? "0" : ""}
              canLoad={canConnect}
              connKey={connKey}
              load={() => api.dbListDatabases(buildInput())}
            />
          </Field>

          <Field label="TLS / SSL">
            <Select value={sslMode} onValueChange={(v) => setSslMode(v as DbSslMode)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SSL_MODES.filter((m) => kind !== "redis" || m.id !== "prefer").map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {kind === "clickhouse" && (
            <p className="-mt-1 text-xs text-muted-foreground">
              Uses the HTTP interface — usually port 8123, or 8443 with TLS.
            </p>
          )}

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

/**
 * Ô database: gõ tay, hoặc bấm ▾ để kết nối thử và chọn từ danh sách database
 * trên server. Danh sách bị bỏ khi thông số kết nối đổi (`connKey`).
 */
function DatabasePicker({
  value,
  onChange,
  placeholder,
  canLoad,
  connKey,
  load,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  canLoad: boolean;
  connKey: string;
  load: () => Promise<string[]>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    setErr(null);
  }, [connKey]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    if (list !== null || loading) return;
    setLoading(true);
    setErr(null);
    try {
      setList(await load());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Đang gõ → lọc danh sách theo chữ đã gõ (nếu không khớp thì vẫn hiện tất cả).
  const q = value.trim().toLowerCase();
  const filtered = list?.filter((n) => n.toLowerCase().includes(q)) ?? [];
  const shown = filtered.length ? filtered : (list ?? []);

  return (
    <div ref={box} className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10"
        onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={!canLoad}
        title={canLoad ? "List databases on the server" : "Fill in host and credentials first"}
        className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />}
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-lg">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Connecting…
            </div>
          ) : err ? (
            <div className="whitespace-pre-wrap break-words px-3 py-2 text-xs text-destructive">{err}</div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">(no databases)</div>
          ) : (
            shown.map((n) => (
              <button
                key={n}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(n);
                  setOpen(false);
                }}
                className={cn("block w-full truncate px-3 py-1.5 text-left hover:bg-accent", n === value && "font-medium text-primary")}
              >
                {n}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
