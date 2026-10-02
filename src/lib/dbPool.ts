// Trạng thái từng pane Database, sống NGOÀI component (giống terminalPool): đổi
// task/workspace làm dockview gỡ rồi gắn lại pane, nhưng phiên kết nối, câu SQL
// đang soạn, kết quả và cây schema vẫn giữ nguyên. Chỉ `release` (đóng pane hẳn)
// mới đóng phiên phía backend.
import { useSyncExternalStore } from "react";
import { api, DbKind, DbQueryOutput, DbSessionInfo, DbTreeNode } from "./ipc";

export interface DbPane {
  connId: string;
  kind: DbKind;
  status: "connecting" | "ready" | "error";
  error: string | null;
  session: DbSessionInfo | null;
  sql: string;
  /** Database chạy câu lệnh (null = mặc định của kết nối). */
  database: string | null;
  limit: number;
  running: boolean;
  output: DbQueryOutput | null;
  queryError: string | null;
  activeResult: number;
  /** Cây schema: khoá = đường dẫn nối bằng \u0000 ("" = gốc). */
  children: Record<string, DbTreeNode[]>;
  expanded: Record<string, boolean>;
  treeError: string | null;
}

const panes = new Map<string, DbPane>();
const listeners = new Map<string, Set<() => void>>();

export const pathKey = (path: string[]) => path.join("\u0000");

function set(panelId: string, patch: Partial<DbPane>) {
  const cur = panes.get(panelId);
  if (!cur) return;
  panes.set(panelId, { ...cur, ...patch });
  listeners.get(panelId)?.forEach((l) => l());
}

export function get(panelId: string): DbPane | undefined {
  return panes.get(panelId);
}

/** Hook đọc trạng thái pane (re-render khi đổi). */
export function useDbPane(panelId: string): DbPane | undefined {
  return useSyncExternalStore(
    (cb) => {
      let s = listeners.get(panelId);
      if (!s) listeners.set(panelId, (s = new Set()));
      s.add(cb);
      return () => s!.delete(cb);
    },
    () => panes.get(panelId)
  );
}

/** Tạo pane (lần đầu) và mở phiên. Gắn lại sau khi đổi task → giữ nguyên. */
export function ensure(panelId: string, connId: string, kind: DbKind) {
  if (panes.has(panelId)) return;
  panes.set(panelId, {
    connId,
    kind,
    status: "connecting",
    error: null,
    session: null,
    sql: "",
    database: null,
    limit: 1000,
    running: false,
    output: null,
    queryError: null,
    activeResult: 0,
    children: {},
    expanded: {},
    treeError: null,
  });
  queueMicrotask(() => void connect(panelId)); // không set state giữa lúc render
}

export async function connect(panelId: string) {
  const p = panes.get(panelId);
  if (!p) return;
  if (p.session) api.dbClose(p.session.session_id).catch(() => {});
  set(panelId, { status: "connecting", error: null, session: null, children: {}, treeError: null });
  try {
    const session = await api.dbOpen(p.connId);
    if (!panes.has(panelId)) {
      api.dbClose(session.session_id).catch(() => {}); // pane đã đóng trong lúc chờ
      return;
    }
    set(panelId, { status: "ready", session, database: panes.get(panelId)!.database ?? session.database });
    void loadChildren(panelId, []);
  } catch (e) {
    set(panelId, { status: "error", error: String(e) });
  }
}

/** Đóng pane hẳn: đóng phiên backend, xoá trạng thái. */
export function release(panelId: string) {
  const p = panes.get(panelId);
  if (!p) return;
  panes.delete(panelId);
  if (p.session) api.dbClose(p.session.session_id).catch(() => {});
  listeners.delete(panelId);
}

export function update(panelId: string, patch: Partial<Pick<DbPane, "sql" | "database" | "limit" | "activeResult">>) {
  set(panelId, patch);
}

export async function loadChildren(panelId: string, path: string[]) {
  const p = panes.get(panelId);
  if (!p?.session) return;
  try {
    const nodes = await api.dbTree(p.session.session_id, path);
    const cur = panes.get(panelId);
    if (!cur) return;
    set(panelId, { children: { ...cur.children, [pathKey(path)]: nodes }, treeError: null });
  } catch (e) {
    set(panelId, { treeError: String(e) });
  }
}

export function toggle(panelId: string, path: string[]) {
  const p = panes.get(panelId);
  if (!p) return;
  const k = pathKey(path);
  const open = !p.expanded[k];
  set(panelId, { expanded: { ...p.expanded, [k]: open } });
  if (open && !p.children[k]) void loadChildren(panelId, path);
}

export function refreshTree(panelId: string) {
  const p = panes.get(panelId);
  if (!p) return;
  set(panelId, { children: {} });
  void loadChildren(panelId, []);
  for (const [k, open] of Object.entries(p.expanded)) {
    if (open) void loadChildren(panelId, k.split("\u0000"));
  }
}

export async function run(panelId: string, sql: string, database?: string | null) {
  const p = panes.get(panelId);
  if (!p?.session || p.running || !sql.trim()) return;
  const db = database !== undefined ? database : p.database;
  set(panelId, { running: true, queryError: null, database: db });
  try {
    const output = await api.dbQuery(p.session.session_id, db, sql, p.limit);
    set(panelId, { output, activeResult: lastWithRows(output), running: false, database: output.database ?? db });
    pushHistory(p.connId, sql);
  } catch (e) {
    set(panelId, { queryError: String(e), running: false });
  }
}

/** Mặc định mở tập kết quả cuối có cột (thường là SELECT cuối cùng). */
function lastWithRows(o: DbQueryOutput): number {
  for (let i = o.results.length - 1; i >= 0; i--) if (o.results[i].columns.length) return i;
  return Math.max(0, o.results.length - 1);
}

export async function cancel(panelId: string) {
  const p = panes.get(panelId);
  if (!p?.session || !p.running) return;
  await api.dbCancel(p.session.session_id).catch(() => {});
}

// ----- Lịch sử câu lệnh theo kết nối (localStorage, tối đa 100) -----

export interface HistoryItem {
  sql: string;
  at: number;
}

const histKey = (connId: string) => `db-history:${connId}`;

export function history(connId: string): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(histKey(connId)) || "[]");
  } catch {
    return [];
  }
}

function pushHistory(connId: string, sql: string) {
  const text = sql.trim();
  const list = history(connId).filter((h) => h.sql !== text);
  list.unshift({ sql: text, at: Date.now() });
  try {
    localStorage.setItem(histKey(connId), JSON.stringify(list.slice(0, 100)));
  } catch {
    /* hết chỗ / bị chặn — bỏ qua */
  }
}
