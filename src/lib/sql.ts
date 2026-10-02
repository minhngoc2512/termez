// Tiện ích SQL phía giao diện: tách câu lệnh, bao tên định danh, cảnh báo câu
// lệnh nguy hiểm, xuất CSV/JSON. Không phải parser SQL đầy đủ — chỉ đủ an toàn
// với chuỗi, định danh có nháy và comment.
import type { DbKind, DbResultSet } from "./ipc";

export type Dialect = "mysql" | "postgres" | "clickhouse" | "redis" | "mongodb" | "bigquery";

export function dialectOf(kind: DbKind): Dialect {
  if (kind === "postgres" || kind === "clickhouse" || kind === "redis" || kind === "mongodb" || kind === "bigquery") return kind;
  return "mysql";
}

/** Bao một tên (bảng, cột, schema…) theo cú pháp của dialect. */
export function quoteIdent(name: string, d: Dialect): string {
  return d === "postgres" ? '"' + name.replace(/"/g, '""') + '"' : "`" + name.replace(/`/g, "``") + "`";
}

/** Tên bảng đầy đủ từ đường dẫn cây: MySQL [db, bảng] · PostgreSQL [db, schema, bảng]. */
export function qualifiedTable(path: string[], d: Dialect): string {
  return path
    .slice(-2)
    .map((p) => quoteIdent(p, d))
    .join(".");
}

export interface Statement {
  text: string;
  start: number;
  end: number;
}

/**
 * Tách thành các câu lệnh theo `;` ở cấp ngoài cùng: bỏ qua `;` trong chuỗi
 * ('…', "…", `…`), dollar-quote của PostgreSQL ($tag$…$tag$) và comment (-- , #, /* *\/).
 */
export function splitStatements(sql: string, d: Dialect): Statement[] {
  if (d === "redis") return splitLines(sql);
  if (d === "mongodb") return splitMongo(sql);
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const text = raw.trim();
    if (text && stripComments(text).trim()) out.push({ text, start, end });
    start = end + 1;
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      i = lineEnd(sql, i);
    } else if (c === "#" && (d === "mysql" || d === "bigquery")) {
      i = lineEnd(sql, i);
    } else if (c === "/" && next === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"' || (c === "`" && (d === "mysql" || d === "bigquery"))) {
      i = quoteEnd(sql, i, c);
    } else if (c === "$" && d === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
      } else i++;
    } else if (c === ";") {
      push(i);
      i++;
    } else i++;
  }
  push(n);
  return out;
}

/** Redis: mỗi dòng (không rỗng, không phải comment #, //) là một lệnh. */
function splitLines(text: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith("//")) out.push({ text: t, start, end: start + line.length });
    start += line.length + 1;
  }
  return out;
}

/**
 * MongoDB shell: tách theo `;` ở cấp ngoài cùng, hoặc xuống dòng ở cấp ngoài cùng khi
 * dòng sau bắt đầu câu mới (db. / db[ / show / use) — khớp split_script phía Rust.
 */
function splitMongo(src: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  const n = src.length;
  const push = (end: number) => {
    const raw = src.slice(start, end);
    const text = raw.replace(/^(\s*\/\/[^\n]*\n?)+/, "").trim();
    if (text) {
      const lead = raw.indexOf(text);
      out.push({ text, start: start + Math.max(lead, 0), end });
    }
    start = end + 1;
  };
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"') i = quoteEnd(src, i, c);
    else if (c === "/" && src[i + 1] === "/") i = lineEnd(src, i) - 1;
    else {
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === ";" && depth <= 0) push(i);
      else if (c === "\n" && depth <= 0 && /^\s*(db\.|db\[|show |use )/.test(src.slice(i + 1, i + 40))) push(i);
      i++;
    }
  }
  push(n);
  return out;
}

function lineEnd(s: string, i: number): number {
  const e = s.indexOf("\n", i);
  return e < 0 ? s.length : e + 1;
}

function quoteEnd(s: string, i: number, q: string): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\" && q !== "`") j += 2;
    else if (s[j] === q) {
      if (s[j + 1] === q) j += 2; // '' → nháy thoát
      else return j + 1;
    } else j++;
  }
  return s.length;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#)[^\n]*/g, " ");
}

/** Câu lệnh tại vị trí con trỏ (nếu con trỏ ngay sau `;` thì lấy câu trước đó). */
export function statementAt(sql: string, pos: number, d: Dialect): Statement | null {
  const list = splitStatements(sql, d);
  return list.find((s) => pos >= s.start && pos <= s.end + 1) ?? list[list.length - 1] ?? null;
}

/**
 * Câu lệnh có thể phá dữ liệu: UPDATE/DELETE không WHERE, DROP, TRUNCATE.
 * Trả về mô tả ngắn từng câu để hỏi xác nhận.
 */
export function dangerousStatements(sql: string, d: Dialect): string[] {
  const out: string[] = [];
  if (d === "redis") {
    for (const st of splitLines(sql)) {
      const cmd = st.text.split(/\s+/)[0].toUpperCase();
      if (["FLUSHALL", "FLUSHDB", "SHUTDOWN", "SWAPDB", "DEBUG", "MIGRATE"].includes(cmd)) out.push(st.text);
      else if (cmd === "KEYS") out.push(`${st.text} … (blocks the server on large databases — prefer SCAN)`);
      else if (cmd === "CONFIG" && /^config\s+(set|resetstat|rewrite)/i.test(st.text)) out.push(st.text);
    }
    return out;
  }
  if (d === "mongodb") {
    for (const st of splitMongo(sql)) {
      const t = st.text.replace(/\s+/g, "");
      const head = st.text.slice(0, 80).replace(/\s+/g, " ");
      if (/\.(drop|dropDatabase|dropIndexes?)\(/.test(t) || /dropDatabase|["']?drop["']?:/.test(t)) out.push(head);
      else if (/\.(deleteMany|updateMany|remove)\(\{\}[,)]/.test(t)) out.push(`${head} … (empty filter — affects every document)`);
    }
    return out;
  }
  for (const st of splitStatements(sql, d)) {
    const t = stripComments(st.text).replace(/'(?:[^']|'')*'/g, "''").trim();
    const head = t.slice(0, 80).replace(/\s+/g, " ");
    if (/^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t)) out.push(`${head} … (no WHERE — affects every row)`);
    else if (/^(drop|truncate)\b/i.test(t)) out.push(head);
  }
  return out;
}

function csvCell(v: string | null): string {
  if (v === null) return "";
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function toCsv(rs: DbResultSet): string {
  const lines = [rs.columns.map((c) => csvCell(c.name)).join(",")];
  for (const r of rs.rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

export function toJson(rs: DbResultSet): string {
  const names = rs.columns.map((c) => c.name);
  return JSON.stringify(
    rs.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))),
    null,
    2
  );
}

/** Cột trông như số (căn phải trong lưới). */
export function isNumericType(t: string | null): boolean {
  // MySQL: "long", "newdecimal"… · ClickHouse: "UInt64", "Nullable(Float64)", "Decimal(10, 2)"…
  // BigQuery: "INTEGER", "INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC".
  return !!t && /^((nullable|lowcardinality)\()*(tiny|short|long|u?int|int24|float|double|decimal|newdecimal|year|numeric|bignumeric)/i.test(t);
}
