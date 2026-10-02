import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Compartment, Prec, Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { Dialect, statementAt } from "../../lib/sql";

export const MONO = 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace';

// Màu theo token của app (đổi theo theme sáng/tối qua CSS variable).
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  ".cm-gutters": { backgroundColor: "var(--sidebar)", color: "var(--muted-foreground)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 70%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 28%, transparent) !important",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--primary)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "#d97706" },
  { tag: [t.number, t.bool, t.null], color: "#0891b2" },
  { tag: [t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "#8b5cf6" },
  { tag: [t.special(t.name), t.quote], color: "#db2777" },
]);

const MONGO_DB_METHODS = ["getCollection", "getCollectionNames", "runCommand", "adminCommand", "stats", "serverStatus", "version", "dropDatabase"];
const MONGO_COLL_METHODS = [
  "find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct", "insertOne", "insertMany",
  "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "getIndexes", "createIndex", "dropIndex", "stats", "drop",
];
const MONGO_CURSOR_METHODS = ["sort", "limit", "skip", "projection", "count"];

/** Gợi ý cho console MongoDB: db.<collection> / db.<method>, rồi phương thức của collection / cursor. */
function mongoCompletions(schema: Record<string, string[]>) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const opts = (labels: string[], type: string) => labels.map((label) => ({ label, type }));
    const db = ctx.matchBefore(/\bdb\.\w*$/);
    if (db) {
      return {
        from: db.from + 3,
        options: [...opts(Object.keys(schema), "class"), ...opts(MONGO_DB_METHODS, "method")],
        validFor: /^\w*$/,
      };
    }
    const coll = ctx.matchBefore(/\bdb\.(\w+|getCollection\((["'])[^"']*\2\))\.\w*$/);
    if (coll) {
      const dot = coll.text.lastIndexOf(".");
      return { from: coll.from + dot + 1, options: opts(MONGO_COLL_METHODS, "method"), validFor: /^\w*$/ };
    }
    const cursor = ctx.matchBefore(/\)\s*\.\w*$/);
    if (cursor) {
      const dot = cursor.text.lastIndexOf(".");
      return { from: cursor.from + dot + 1, options: opts(MONGO_CURSOR_METHODS, "method"), validFor: /^\w*$/ };
    }
    return null;
  };
}

/** Ngôn ngữ của editor: SQL theo dialect (ClickHouse dùng cú pháp gần MySQL); Redis = văn bản thường;
 *  MongoDB = cú pháp JavaScript (mongo shell). */
function language(d: Dialect, schema: Record<string, string[]>): Extension {
  if (d === "redis") return [];
  if (d === "mongodb") return [javascript(), javascriptLanguage.data.of({ autocomplete: mongoCompletions(schema) })];
  return sql({ dialect: d === "postgres" ? PostgreSQL : MySQL, schema, upperCaseKeywords: true });
}

/** Format SQL (thư viện tải khi dùng lần đầu). Redis không có format. */
async function formatSql(text: string, d: Dialect): Promise<string> {
  const { format } = await import("sql-formatter");
  return format(text, {
    language: d === "postgres" ? "postgresql" : d === "clickhouse" ? "clickhouse" : d === "bigquery" ? "bigquery" : "mysql",
    keywordCase: "upper",
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
}

export interface SqlEditorHandle {
  /** Văn bản để chạy: vùng chọn; không chọn → câu tại con trỏ (hoặc cả script nếu `all`). */
  runText(all: boolean): string;
  /** Format vùng chọn, hoặc cả nội dung nếu không chọn gì. */
  format(): Promise<void>;
  focus(): void;
}

interface Props {
  value: string;
  dialect: Dialect;
  /** Bảng → cột, cho gợi ý tự động. */
  schema: Record<string, string[]>;
  onChange: (v: string) => void;
  onRun: (all: boolean) => void;
  /** Lỗi khi format (cú pháp không hiểu được…). */
  onFormatError?: (msg: string) => void;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { value, dialect, schema, onChange, onRun, onFormatError },
  ref
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const cb = useRef({ onChange, onRun, dialect, onFormatError });
  cb.current = { onChange, onRun, dialect, onFormatError };

  async function doFormat() {
    const v = view.current;
    if (!v || cb.current.dialect === "redis" || cb.current.dialect === "mongodb") return;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? v.state.doc.length : sel.to;
    const text = v.state.sliceDoc(from, to);
    if (!text.trim()) return;
    try {
      const out = await formatSql(text, cb.current.dialect);
      v.dispatch({ changes: { from, to, insert: out }, selection: { anchor: from } });
      v.focus();
    } catch (e) {
      cb.current.onFormatError?.(String(e));
    }
  }

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          placeholder(
            dialect === "redis"
              ? "GET key   (one command per line · Ctrl+Enter: run line · Ctrl+Shift+Enter: run all)"
              : dialect === "mongodb"
              ? "db.collection.find({ … })   (show dbs · use <db> · Ctrl+Enter: run statement · Ctrl+Shift+Enter: run all)"
              : "SELECT …   (Ctrl+Enter: run statement · Ctrl+Shift+Enter: run all · Ctrl+Alt+L: format)"
          ),
          lang.current.of(language(dialect, {})),
          syntaxHighlighting(highlight),
          theme,
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (cb.current.onRun(false), true) },
              { key: "Mod-Shift-Enter", run: () => (cb.current.onRun(true), true) },
              // Format như DataGrip (Ctrl+Alt+L) và VS Code (Shift+Alt+F).
              { key: "Mod-Alt-l", run: () => (void doFormat(), true) },
              { key: "Shift-Alt-f", run: () => (void doFormat(), true) },
            ])
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Chỉ tạo một lần; giá trị/dialect cập nhật qua các effect dưới.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(language(dialect, schema)) });
  }, [dialect, schema]);

  // Giá trị đổi từ ngoài (chọn lịch sử, double-click bảng…) → thay nội dung.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    runText(all: boolean) {
      const v = view.current;
      if (!v) return "";
      const doc = v.state.doc.toString();
      const sel = v.state.selection.main;
      if (!sel.empty) return v.state.sliceDoc(sel.from, sel.to);
      if (all) return doc;
      return statementAt(doc, sel.head, cb.current.dialect)?.text ?? "";
    },
    format: doFormat,
    focus() {
      view.current?.focus();
    },
  }));

  return <div ref={host} className="h-full overflow-hidden" />;
});
