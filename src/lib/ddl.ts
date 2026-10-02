// Sinh câu lệnh quản lý cấu trúc (tạo/xoá database, bảng, index; truncate) theo
// dialect. Câu lệnh luôn hiện cho người dùng xem trước khi chạy.
import type { DbResultSet } from "./ipc";
import { Dialect, quoteIdent } from "./sql";

export interface ColumnDef {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  /** Biểu thức DEFAULT (giữ nguyên văn), rỗng = không có. */
  def: string;
}

export interface IndexInfo {
  name: string;
  /** Cột / biểu thức hiển thị. */
  columns: string;
  unique: boolean;
  primary: boolean;
  /** Chi tiết thêm (kiểu index, định nghĩa…). */
  detail: string;
  /** PostgreSQL: index thuộc một constraint (PK/UNIQUE) → xoá bằng DROP CONSTRAINT. */
  constraint?: boolean;
}

/** Gợi ý kiểu cột khi tạo bảng. */
export const COLUMN_TYPES: Record<string, string[]> = {
  mysql: ["INT", "BIGINT", "INT AUTO_INCREMENT", "BIGINT AUTO_INCREMENT", "VARCHAR(255)", "TEXT", "BOOLEAN", "DECIMAL(10,2)", "DOUBLE", "DATE", "DATETIME", "TIMESTAMP", "JSON", "BLOB"],
  postgres: ["integer", "bigint", "serial", "bigserial", "text", "varchar(255)", "boolean", "numeric(10,2)", "double precision", "date", "timestamp", "timestamptz", "jsonb", "uuid", "bytea"],
  bigquery: ["INT64", "STRING", "BOOL", "FLOAT64", "NUMERIC", "BIGNUMERIC", "DATE", "DATETIME", "TIMESTAMP", "TIME", "JSON", "BYTES", "GEOGRAPHY", "ARRAY<STRING>", "STRUCT<a INT64, b STRING>"],
  clickhouse: ["UInt32", "UInt64", "Int32", "Int64", "String", "LowCardinality(String)", "Bool", "Float64", "Decimal(18,2)", "Date", "DateTime", "DateTime64(3)", "UUID", "Array(String)", "Map(String, String)"],
};

export const CH_INDEX_TYPES = ["minmax", "set(100)", "bloom_filter", "ngrambf_v1(3, 256, 2, 0)", "tokenbf_v1(256, 2, 0)"];

/** Chuỗi literal SQL ('…'). */
export function sqlString(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** Bảng đầy đủ: MySQL/ClickHouse [db, bảng] · PostgreSQL [db, schema, bảng] (bỏ db). */
function table(path: string[], d: Dialect): string {
  return path.slice(-2).map((p) => quoteIdent(p, d)).join(".");
}

/** Collection trong mongo shell. */
export function mongoColl(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !["getCollection", "runCommand", "stats", "createCollection"].includes(name)
    ? `db.${name}`
    : `db.getCollection(${JSON.stringify(name)})`;
}

export function createDatabase(d: Dialect, name: string, opts: { charset?: string; location?: string } = {}): string {
  if (d === "bigquery") {
    const loc = opts.location?.trim();
    return `CREATE SCHEMA ${quoteIdent(name, d)}${loc ? ` OPTIONS (location = ${sqlString(loc)})` : ""};`;
  }
  if (d === "mysql") {
    const cs = opts.charset?.trim();
    return `CREATE DATABASE ${quoteIdent(name, d)}${cs ? ` CHARACTER SET ${cs}` : ""};`;
  }
  return `CREATE DATABASE ${quoteIdent(name, d)};`;
}

export function dropDatabase(d: Dialect, name: string): string {
  if (d === "mongodb") return "db.dropDatabase()";
  if (d === "redis") return "FLUSHDB";
  // BigQuery: dataset = schema; không CASCADE thì chỉ xoá được dataset rỗng.
  if (d === "bigquery") return `DROP SCHEMA ${quoteIdent(name, d)} CASCADE;`;
  return `DROP DATABASE ${quoteIdent(name, d)};`;
}

export function createSchema(name: string): string {
  return `CREATE SCHEMA ${quoteIdent(name, "postgres")};`;
}

export function dropSchema(name: string): string {
  return `DROP SCHEMA ${quoteIdent(name, "postgres")};`;
}

export function createTable(d: Dialect, path: string[], cols: ColumnDef[], opts: { engine?: string; orderBy?: string } = {}): string {
  const used = cols.filter((c) => c.name.trim() && c.type.trim());
  const pk = used.filter((c) => c.pk).map((c) => quoteIdent(c.name.trim(), d));
  const lines = used.map((c) => {
    const n = quoteIdent(c.name.trim(), d);
    let t = c.type.trim();
    if (d === "clickhouse") {
      // ClickHouse: cột mặc định NOT NULL; cho phép NULL = bọc Nullable(…).
      if (!c.notNull && !c.pk && !/^nullable\(/i.test(t)) t = `Nullable(${t})`;
      return `  ${n} ${t}${c.def.trim() ? ` DEFAULT ${c.def.trim()}` : ""}`;
    }
    return `  ${n} ${t}${c.notNull || c.pk ? " NOT NULL" : ""}${c.def.trim() ? ` DEFAULT ${c.def.trim()}` : ""}`;
  });
  // BigQuery: khoá chính chỉ là metadata cho optimizer, bắt buộc ghi NOT ENFORCED.
  if (d !== "clickhouse" && pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})${d === "bigquery" ? " NOT ENFORCED" : ""}`);
  let sql = `CREATE TABLE ${table(path, d)} (\n${lines.join(",\n")}\n)`;
  if (d === "clickhouse") {
    const order = opts.orderBy?.trim() || (pk.length ? `(${pk.join(", ")})` : "tuple()");
    sql += `\nENGINE = ${opts.engine?.trim() || "MergeTree"}\nORDER BY ${order}`;
  }
  return sql + ";";
}

export function truncateTable(d: Dialect, path: string[]): string {
  if (d === "mongodb") return `${mongoColl(path[path.length - 1])}.deleteMany({})`;
  return `TRUNCATE TABLE ${table(path, d)};`;
}

export function dropTable(d: Dialect, path: string[], view = false): string {
  if (d === "mongodb") return `${mongoColl(path[path.length - 1])}.drop()`;
  return `DROP ${view ? "VIEW" : "TABLE"} ${table(path, d)};`;
}

export function createCollection(name: string): string {
  return `db.createCollection(${JSON.stringify(name)})`;
}

// ----- Index -----

export function listIndexes(d: Dialect, path: string[]): string {
  const t = path[path.length - 1];
  switch (d) {
    case "mysql":
      return `SHOW INDEX FROM ${table(path, d)}`;
    case "postgres":
      return (
        "SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def, x.indisprimary AS is_primary, x.indisunique AS is_unique, " +
        "c.conname IS NOT NULL AS is_constraint, " +
        "(SELECT string_agg(a.attname, ', ' ORDER BY k.n) FROM unnest(x.indkey) WITH ORDINALITY k(attnum, n) " +
        "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols " +
        "FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid " +
        "JOIN pg_namespace n ON n.oid = t.relnamespace LEFT JOIN pg_constraint c ON c.conindid = x.indexrelid AND c.conrelid = t.oid " +
        `WHERE n.nspname = ${sqlString(path[path.length - 2])} AND t.relname = ${sqlString(t)} ORDER BY x.indisprimary DESC, i.relname`
      );
    case "clickhouse":
      return (
        "SELECT name, type_full, expr, granularity FROM system.data_skipping_indices " +
        `WHERE database = ${sqlString(path[0])} AND table = ${sqlString(t)} ORDER BY name`
      );
    case "mongodb":
      return `${mongoColl(t)}.getIndexes()`;
    default:
      return "";
  }
}

/** Kết quả truy vấn danh sách index → IndexInfo[] (gom nhiều dòng một index của MySQL). */
export function parseIndexes(d: Dialect, rs: DbResultSet | undefined): IndexInfo[] {
  if (!rs) return [];
  const col = (name: string) => rs.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  const val = (r: (string | null)[], name: string) => {
    const i = col(name);
    return i < 0 ? null : r[i];
  };
  const truthy = (v: string | null) => v === "t" || v === "true" || v === "1";
  if (d === "mysql") {
    const map = new Map<string, IndexInfo>();
    for (const r of rs.rows) {
      const name = val(r, "Key_name") ?? "";
      const column = val(r, "Column_name") ?? val(r, "Expression") ?? "";
      const cur = map.get(name);
      if (cur) cur.columns += `, ${column}`;
      else
        map.set(name, {
          name,
          columns: column,
          unique: val(r, "Non_unique") === "0",
          primary: name === "PRIMARY",
          detail: val(r, "Index_type") ?? "",
        });
    }
    return [...map.values()];
  }
  if (d === "postgres") {
    return rs.rows.map((r) => ({
      name: val(r, "name") ?? "",
      columns: val(r, "cols") ?? "",
      unique: truthy(val(r, "is_unique")),
      primary: truthy(val(r, "is_primary")),
      constraint: truthy(val(r, "is_constraint")),
      detail: (val(r, "def") ?? "").replace(/^.*\sUSING\s/i, "USING "),
    }));
  }
  if (d === "clickhouse") {
    return rs.rows.map((r) => ({
      name: val(r, "name") ?? "",
      columns: val(r, "expr") ?? "",
      unique: false,
      primary: false,
      detail: `TYPE ${val(r, "type_full") ?? ""} GRANULARITY ${val(r, "granularity") ?? ""}`,
    }));
  }
  if (d === "mongodb") {
    return rs.rows.map((r) => {
      const name = val(r, "name") ?? "";
      let keys = val(r, "keys") ?? "";
      try {
        keys = Object.entries(JSON.parse(keys) as Record<string, unknown>)
          .map(([k, v]) => `${k} ${v === 1 ? "↑" : v === -1 ? "↓" : String(v)}`)
          .join(", ");
      } catch {
        /* giữ nguyên */
      }
      const extra = ["sparse", "expireAfterSeconds", "partialFilterExpression"]
        .map((k) => [k, val(r, k)] as const)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}: ${v}`);
      return { name, columns: keys, unique: truthy(val(r, "unique")), primary: name === "_id_", detail: extra.join(" · ") };
    });
  }
  return [];
}

export interface NewIndex {
  name: string;
  /** Cột đã chọn (MongoDB: kèm hướng). */
  columns: { name: string; desc: boolean }[];
  unique: boolean;
  /** ClickHouse: biểu thức, kiểu, granularity. */
  expr?: string;
  chType?: string;
  granularity?: number;
}

/** Tên index gợi ý: idx_<bảng>_<cột>… (MongoDB: theo quy ước field_1). */
export function suggestIndexName(d: Dialect, tableName: string, ix: NewIndex): string {
  if (d === "mongodb") return ix.columns.map((c) => `${c.name}_${c.desc ? -1 : 1}`).join("_");
  const cols = d === "clickhouse" && ix.expr ? ix.expr.replace(/\W+/g, "_") : ix.columns.map((c) => c.name).join("_");
  return `${ix.unique ? "uq" : "idx"}_${tableName}_${cols}`.replace(/_+/g, "_").replace(/_$/, "").slice(0, 60);
}

export function createIndex(d: Dialect, path: string[], ix: NewIndex): string {
  const t = path[path.length - 1];
  const name = ix.name.trim() || suggestIndexName(d, t, ix);
  if (d === "mongodb") {
    const keys = ix.columns.map((c) => `${JSON.stringify(c.name)}: ${c.desc ? -1 : 1}`).join(", ");
    const opts = [`name: ${JSON.stringify(name)}`, ...(ix.unique ? ["unique: true"] : [])].join(", ");
    return `${mongoColl(t)}.createIndex({ ${keys} }, { ${opts} })`;
  }
  if (d === "clickhouse") {
    const expr = ix.expr?.trim() || ix.columns.map((c) => quoteIdent(c.name, d)).join(", ");
    const e = ix.columns.length > 1 && !ix.expr?.trim() ? `(${expr})` : expr;
    return `ALTER TABLE ${table(path, d)} ADD INDEX ${quoteIdent(name, d)} ${e} TYPE ${ix.chType || "minmax"} GRANULARITY ${ix.granularity || 1};`;
  }
  const cols = ix.columns.map((c) => quoteIdent(c.name, d) + (c.desc ? " DESC" : "")).join(", ");
  return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name, d)} ON ${table(path, d)} (${cols});`;
}

export function dropIndex(d: Dialect, path: string[], ix: IndexInfo): string {
  const t = path[path.length - 1];
  switch (d) {
    case "mongodb":
      return `${mongoColl(t)}.dropIndex(${JSON.stringify(ix.name)})`;
    case "clickhouse":
      return `ALTER TABLE ${table(path, d)} DROP INDEX ${quoteIdent(ix.name, d)};`;
    case "postgres":
      return ix.constraint
        ? `ALTER TABLE ${table(path, d)} DROP CONSTRAINT ${quoteIdent(ix.name, d)};`
        : `DROP INDEX ${quoteIdent(path[path.length - 2], d)}.${quoteIdent(ix.name, d)};`;
    default:
      return `DROP INDEX ${quoteIdent(ix.name, d)} ON ${table(path, d)};`;
  }
}
