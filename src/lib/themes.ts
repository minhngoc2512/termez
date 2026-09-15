import { ITheme } from "@xterm/xterm";

export interface TermThemeDef {
  label: string;
  theme: ITheme;
}

export const TERM_THEMES: Record<string, TermThemeDef> = {
  navy: {
    label: "Termez Navy",
    theme: {
      background: "#0e131c",
      foreground: "#e6edf3",
      cursor: "#4c8dff",
      selectionBackground: "#264f78",
    },
  },
  dark: {
    label: "Dark",
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#ffffff",
      selectionBackground: "#264f78",
    },
  },
  solarized: {
    label: "Solarized Dark",
    theme: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
    },
  },
  hacker: {
    label: "Hacker Green",
    theme: {
      background: "#050805",
      foreground: "#33ff66",
      cursor: "#33ff66",
      selectionBackground: "#0a3a0a",
    },
  },
  light: {
    label: "Light",
    theme: {
      background: "#fafafa",
      foreground: "#2e3436",
      cursor: "#0057d8",
      selectionBackground: "#cfe3ff",
    },
  },
};

export const DEFAULT_THEME = "navy";

export function resolveTheme(name: string | null | undefined): ITheme {
  return (name && TERM_THEMES[name]?.theme) || TERM_THEMES[DEFAULT_THEME].theme;
}
