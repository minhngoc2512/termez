// Dialog quản lý cấu trúc từ cây schema: tạo database, tạo bảng, xem/tạo/xoá index.
// Mọi thao tác hiện câu lệnh sẽ chạy; có thể mở câu lệnh vào editor thay vì chạy ngay.
import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2, KeyRound, Code2, ArrowDown, ArrowUp } from "lucide-react";
import * as dbPool from "../../lib/dbPool";
import { Dialect } from "../../lib/sql";
import * as ddl from "../../lib/ddl";
import { confirmDialog } from "../../lib/dialogs";
import { CopyableError } from "./CopyableError";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type DdlRequest =
  | { type: "createDatabase" }
  | { type: "createSchema"; database: string }
  | { type: "createTable"; base: string[] }
  | { type: "indexes"; path: string[] };

interface HostProps {
  panelId: string;
  d: Dialect;
  req: DdlRequest | null;
  onClose: () => void;
  /** Đưa câu lệnh vào editor (không chạy). */
  onOpenInEditor: (sql: string, database: string | null) => void;
}

/** Ô xem trước câu lệnh sẽ chạy. */
function Preview({ sql }: { sql: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">Statement</div>
      <pre className="selectable max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
        {sql || "—"}
      </pre>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function DdlHost(props: HostProps) {
  const { req } = props;
  return (
    <>
      <CreateDatabaseDialog {...props} open={req?.type === "createDatabase" || req?.type === "createSchema"} />
      <CreateTableDialog {...props} open={req?.type === "createTable"} />
      <IndexesDialog {...props} open={req?.type === "indexes"} />
    </>
  );
}

/** Chạy câu lệnh; trả về thông báo lỗi (null = thành công). */
async function run(panelId: string, sql: string, database: string | null): Promise<string | null> {
  try {
    await dbPool.exec(panelId, sql, database);
    return null;
  } catch (e) {
    return String(e);
  }
}

// ----- Database / schema -----

function CreateDatabaseDialog({ panelId, d, req, onClose, onOpenInEditor, open }: HostProps & { open: boolean }) {
  const schema = req?.type === "createSchema" ? req.database : null;
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [coll, setColl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setColl("");
    setError(null);
  }, [open]);

  const n = name.trim();
  // MongoDB không có lệnh tạo database: database xuất hiện khi có collection đầu tiên.
  const sql = !n
    ? ""
    : schema !== null
      ? ddl.createSchema(n)
      : d === "mongodb"
        ? coll.trim()
          ? ddl.createCollection(coll.trim())
          : ""
        : ddl.createDatabase(d, n, { charset: d === "mysql" ? charset : undefined });
  const database = schema ?? (d === "mongodb" ? n : null);

  async function create() {
    setBusy(true);
    const err = await run(panelId, sql, database);
    setBusy(false);
    if (err) return setError(err);
    void dbPool.loadChildren(panelId, schema !== null ? [schema] : []);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{schema !== null ? `New schema in ${schema}` : "New database"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={schema !== null ? "Schema name" : "Database name"}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sql && create()} />
          </Field>
          {d === "mysql" && schema === null && (
            <Field label="Character set">
              <Select value={charset || "__default"} onValueChange={(v) => setCharset(v === "__default" ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">(server default)</SelectItem>
                  {["utf8mb4", "utf8mb3", "latin1", "ascii", "binary"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {d === "mongodb" && (
            <Field label="First collection">
              <Input value={coll} onChange={(e) => setColl(e.target.value)} placeholder="MongoDB creates the database with its first collection" />
            </Field>
          )}
          <Preview sql={sql} />
          {error && <CopyableError text={error} />}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={!sql} onClick={() => (onOpenInEditor(sql, database), onClose())}>
            <Code2 className="size-4" /> Open in editor
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={!sql || busy} onClick={create}>
              {busy && <Loader2 className="size-4 animate-spin" />} Create
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- Bảng -----

const emptyCol = (): ddl.ColumnDef => ({ name: "", type: "", notNull: false, pk: false, def: "" });

function firstCols(d: Dialect): ddl.ColumnDef[] {
  const id: Record<string, string> = { mysql: "BIGINT AUTO_INCREMENT", postgres: "bigserial", clickhouse: "UInt64" };
  const text: Record<string, string> = { mysql: "VARCHAR(255)", postgres: "text", clickhouse: "String" };
  return [
    { name: "id", type: id[d] ?? "", notNull: true, pk: true, def: "" },
    { name: "name", type: text[d] ?? "", notNull: false, pk: false, def: "" },
  ];
}

function CreateTableDialog({ panelId, d, req, onClose, onOpenInEditor, open }: HostProps & { open: boolean }) {
  const base = req?.type === "createTable" ? req.base : [];
  const [name, setName] = useState("");
  const [cols, setCols] = useState<ddl.ColumnDef[]>([]);
  const [engine, setEngine] = useState("MergeTree");
  const [orderBy, setOrderBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCols(firstCols(d));
    setEngine("MergeTree");
    setOrderBy("");
    setError(null);
  }, [open, d]);

  const n = name.trim();
  const sql =
    !n || !base.length
      ? ""
      : d === "mongodb"
        ? ddl.createCollection(n)
        : cols.some((c) => c.name.trim() && c.type.trim())
          ? ddl.createTable(d, [...base, n], cols, { engine, orderBy })
          : "";
  const patch = (i: number, p: Partial<ddl.ColumnDef>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const types = ddl.COLUMN_TYPES[d] ?? [];
  const listId = `coltypes-${d}`;

  async function create() {
    setBusy(true);
    const err = await run(panelId, sql, base[0]);
    setBusy(false);
    if (err) return setError(err);
    void dbPool.loadChildren(panelId, base);
    onClose();
  }

  const where = base.join(".");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn(d === "mongodb" ? "sm:max-w-lg" : "sm:max-w-3xl", "max-h-[90vh] overflow-y-auto")}>
        <DialogHeader>
          <DialogTitle>
            {d === "mongodb" ? "New collection" : "New table"} in <span className="font-mono">{where}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={d === "mongodb" ? "Collection name" : "Table name"}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {d !== "mongodb" && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Columns</div>
              <datalist id={listId}>
                {types.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div className="rounded-md border border-border">
                <div className="grid grid-cols-[1fr_1fr_4.5rem_3rem_1fr_2rem] gap-2 border-b border-border px-2 py-1.5 text-[11px] text-muted-foreground">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Not null</span>
                  <span>PK</span>
                  <span>Default</span>
                  <span />
                </div>
                {cols.map((c, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_4.5rem_3rem_1fr_2rem] items-center gap-2 px-2 py-1">
                    <Input className="h-8 font-mono text-xs" value={c.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="column" />
                    <Input className="h-8 font-mono text-xs" list={listId} value={c.type} onChange={(e) => patch(i, { type: e.target.value })} placeholder="type" />
                    <Checkbox checked={c.notNull || c.pk} disabled={c.pk} onCheckedChange={(v) => patch(i, { notNull: v === true })} />
                    <Checkbox checked={c.pk} onCheckedChange={(v) => patch(i, { pk: v === true })} />
                    <Input className="h-8 font-mono text-xs" value={c.def} onChange={(e) => patch(i, { def: e.target.value })} placeholder="expression" />
                    <button
                      type="button"
                      title="Remove column"
                      onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setCols((cs) => [...cs, emptyCol()])}
                  className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                >
                  <Plus className="size-3.5" /> Add column
                </button>
              </div>
            </div>
          )}

          {d === "clickhouse" && (
            <div className="flex gap-3">
              <Field label="Engine" className="flex-1">
                <Input className="font-mono text-xs" value={engine} onChange={(e) => setEngine(e.target.value)} list="ch-engines" />
                <datalist id="ch-engines">
                  {["MergeTree", "ReplacingMergeTree", "SummingMergeTree", "AggregatingMergeTree", "Log", "Memory"].map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
              </Field>
              <Field label="ORDER BY (default: primary key columns)" className="flex-1">
                <Input className="font-mono text-xs" value={orderBy} onChange={(e) => setOrderBy(e.target.value)} placeholder="tuple()" />
              </Field>
            </div>
          )}

          <Preview sql={sql} />
          {error && <CopyableError text={error} />}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={!sql} onClick={() => (onOpenInEditor(sql, base[0] ?? null), onClose())}>
            <Code2 className="size-4" /> Open in editor
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={!sql || busy} onClick={create}>
              {busy && <Loader2 className="size-4 animate-spin" />} Create
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- Index -----

function IndexesDialog({ panelId, d, req, onClose, onOpenInEditor, open }: HostProps & { open: boolean }) {
  const path = useMemo(() => (req?.type === "indexes" ? req.path : []), [req]);
  const pane = dbPool.useDbPane(panelId);
  const readOnly = !!pane?.session?.read_only;
  const table = path[path.length - 1] ?? "";
  const [list, setList] = useState<ddl.IndexInfo[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ name: string; desc: boolean }[]>([]);
  const [unique, setUnique] = useState(false);
  const [ixName, setIxName] = useState("");
  const [expr, setExpr] = useState("");
  const [chType, setChType] = useState("minmax");
  const [gran, setGran] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = pane?.children[dbPool.pathKey(path)];
  const columns = (loaded ?? []).filter((n) => n.kind === "column").map((n) => n.name);
  // MongoDB: trường lồng (address.city) hay trường chưa có trong mẫu → gõ tay.
  const [extra, setExtra] = useState("");
  const addExtra = () => {
    const f = extra.trim();
    if (f && !picked.some((x) => x.name === f)) setPicked((p) => [...p, { name: f, desc: false }]);
    setExtra("");
  };

  async function load() {
    setLoadErr(null);
    try {
      const out = await dbPool.exec(panelId, ddl.listIndexes(d, path), path[0]);
      setList(ddl.parseIndexes(d, out.results[out.results.length - 1]));
    } catch (e) {
      setLoadErr(String(e));
      setList([]);
    }
  }

  useEffect(() => {
    if (!open || !path.length) return;
    setList(null);
    setPicked([]);
    setUnique(false);
    setIxName("");
    setExpr("");
    setChType("minmax");
    setGran(1);
    setError(null);
    void load();
    // Cột để chọn khi tạo index (lấy từ cây).
    if (!dbPool.get(panelId)?.children[dbPool.pathKey(path)]) void dbPool.loadChildren(panelId, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  const ix: ddl.NewIndex = { name: ixName, columns: picked, unique, expr, chType, granularity: gran };
  const canCreate = d === "clickhouse" ? !!(expr.trim() || picked.length) : picked.length > 0;
  const sql = canCreate ? ddl.createIndex(d, path, ix) : "";
  const toggle = (c: string) =>
    setPicked((p) => (p.some((x) => x.name === c) ? p.filter((x) => x.name !== c) : [...p, { name: c, desc: false }]));

  async function create() {
    setBusy(true);
    setError(null);
    const err = await run(panelId, sql, path[0]);
    setBusy(false);
    if (err) return setError(err);
    setPicked([]);
    setIxName("");
    setExpr("");
    void load();
  }

  async function drop(i: ddl.IndexInfo) {
    const stmt = ddl.dropIndex(d, path, i);
    const ok = await confirmDialog({
      title: i.primary ? "Drop primary key?" : "Drop index?",
      message: stmt,
      confirmText: "Drop",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    const err = await run(panelId, stmt, path[0]);
    if (err) setError(err);
    void load();
  }

  const directional = d !== "clickhouse";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" /> Indexes of <span className="font-mono">{table}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border">
            {list === null ? (
              <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading indexes…
              </p>
            ) : loadErr ? (
              <CopyableError text={loadErr} className="m-2" />
            ) : list.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                {d === "clickhouse" ? "No data-skipping indexes (the primary key comes from ORDER BY)." : "No indexes."}
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">{d === "clickhouse" ? "Expression" : "Columns"}</th>
                    <th className="px-3 py-2 font-medium">Details</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.name} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                      <td className="selectable px-3 py-1.5 font-mono">
                        {i.name}
                        {i.primary && <span className="ml-1.5 rounded bg-primary/15 px-1 text-[10px] text-primary">PRIMARY</span>}
                        {i.unique && !i.primary && <span className="ml-1.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-500">UNIQUE</span>}
                      </td>
                      <td className="selectable px-3 py-1.5 font-mono">{i.columns}</td>
                      <td className="selectable max-w-[16rem] truncate px-3 py-1.5 text-muted-foreground" title={i.detail}>
                        {i.detail}
                      </td>
                      <td className="px-2">
                        {!readOnly && !(d === "mongodb" && i.name === "_id_") && (
                          <button
                            title="Drop index"
                            onClick={() => drop(i)}
                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!readOnly && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="text-sm font-medium">New index</div>
              <Field label={d === "clickhouse" ? "Columns (or write an expression below)" : "Columns — click to add, in order"}>
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {columns.length === 0 && (
                    <span className="text-xs text-muted-foreground">{loaded ? "No columns found." : "Loading columns…"}</span>
                  )}
                  {[...columns, ...picked.map((p) => p.name).filter((n) => !columns.includes(n))].map((c) => {
                    const at = picked.findIndex((x) => x.name === c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggle(c)}
                        className={cn(
                          "rounded-md border px-2 py-0.5 font-mono text-xs transition-colors",
                          at >= 0 ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {at >= 0 && <span className="mr-1 text-[10px]">{at + 1}</span>}
                        {c}
                      </button>
                    );
                  })}
                </div>
              </Field>
              {d === "mongodb" && (
                <div className="flex gap-2">
                  <Input
                    className="h-8 font-mono text-xs"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addExtra()}
                    placeholder="other field, e.g. address.city"
                  />
                  <Button size="sm" variant="outline" onClick={addExtra} disabled={!extra.trim()}>
                    <Plus className="size-4" /> Add
                  </Button>
                </div>
              )}
              {directional && picked.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {picked.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      title="Toggle ascending / descending"
                      onClick={() => setPicked((ps) => ps.map((x) => (x.name === p.name ? { ...x, desc: !x.desc } : x)))}
                      className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
                    >
                      {p.name} {p.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                    </button>
                  ))}
                </div>
              )}
              {d === "clickhouse" && (
                <div className="flex gap-3">
                  <Field label="Expression" className="flex-[2]">
                    <Input className="font-mono text-xs" value={expr} onChange={(e) => setExpr(e.target.value)} placeholder="lower(name)" />
                  </Field>
                  <Field label="Type" className="flex-[2]">
                    <Input className="font-mono text-xs" value={chType} onChange={(e) => setChType(e.target.value)} list="ch-index-types" />
                    <datalist id="ch-index-types">
                      {ddl.CH_INDEX_TYPES.map((t) => (
                        <option key={t} value={t} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label="Granularity" className="flex-1">
                    <Input type="number" min={1} value={gran} onChange={(e) => setGran(Math.max(1, Number(e.target.value) || 1))} />
                  </Field>
                </div>
              )}
              <div className="flex items-end gap-3">
                <Field label="Name" className="flex-1">
                  <Input
                    className="font-mono text-xs"
                    value={ixName}
                    onChange={(e) => setIxName(e.target.value)}
                    placeholder={canCreate ? ddl.suggestIndexName(d, table, ix) : "auto"}
                  />
                </Field>
                {d !== "clickhouse" && (
                  <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
                    <Checkbox checked={unique} onCheckedChange={(v) => setUnique(v === true)} /> Unique
                  </label>
                )}
              </div>
              {sql && <Preview sql={sql} />}
              {error && <CopyableError text={error} />}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={!sql} onClick={() => (onOpenInEditor(sql, path[0] ?? null), onClose())}>
                  <Code2 className="size-4" /> Open in editor
                </Button>
                <Button size="sm" disabled={!sql || busy} onClick={create}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create index
                </Button>
              </div>
            </div>
          )}
          {readOnly && error && <CopyableError text={error} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
