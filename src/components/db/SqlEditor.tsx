import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Compartment, Prec, Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
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

/** Ngôn ngữ của editor: SQL theo dialect (ClickHouse dùng cú pháp gần MySQL); Redis = văn bản thường. */
function language(d: Dialect, schema: Record<string, string[]>): Extension {
  if (d === "redis") return [];
  return sql({ dialect: d === "postgres" ? PostgreSQL : MySQL, schema, upperCaseKeywords: true });
}

export interface SqlEditorHandle {
  /** Văn bản để chạy: vùng chọn; không chọn → câu tại con trỏ (hoặc cả script nếu `all`). */
  runText(all: boolean): string;
  focus(): void;
}

interface Props {
  value: string;
  dialect: Dialect;
  /** Bảng → cột, cho gợi ý tự động. */
  schema: Record<string, string[]>;
  onChange: (v: string) => void;
  onRun: (all: boolean) => void;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { value, dialect, schema, onChange, onRun },
  ref
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const cb = useRef({ onChange, onRun, dialect });
  cb.current = { onChange, onRun, dialect };

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
              : "SELECT …   (Ctrl+Enter: run statement · Ctrl+Shift+Enter: run all)"
          ),
          lang.current.of(language(dialect, {})),
          syntaxHighlighting(highlight),
          theme,
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (cb.current.onRun(false), true) },
              { key: "Mod-Shift-Enter", run: () => (cb.current.onRun(true), true) },
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
    focus() {
      view.current?.focus();
    },
  }));

  return <div ref={host} className="h-full overflow-hidden" />;
});
