import { ITheme } from "@xterm/xterm";

export interface TermThemeDef {
  label: string;
  theme: ITheme;
}

// Bảng 16 màu ANSI kiểu Terminus (prompt xanh lá, IP hồng/tím, path xanh dương/cyan).
// Dùng cho các theme tối để chữ trong SSH trông có chủ đích, không phải màu mặc định xterm.
const ANSI_TERMINUS = {
  black: "#1c2733",
  red: "#ff5c66",
  green: "#4ade80",
  yellow: "#f5d76e",
  blue: "#4c8dff",
  magenta: "#c792ea",
  cyan: "#56d4dd",
  white: "#cfd8e3",
  brightBlack: "#4b5a6a",
  brightRed: "#ff7b84",
  brightGreen: "#6ee7a0",
  brightYellow: "#ffe08a",
  brightBlue: "#79a9ff",
  brightMagenta: "#d9b3ff",
  brightCyan: "#8be9e3",
  brightWhite: "#ffffff",
} satisfies Partial<ITheme>;

export const TERM_THEMES: Record<string, TermThemeDef> = {
  terminus: {
    label: "Terminus",
    theme: {
      background: "#12181f",
      foreground: "#cfd8e3",
      cursor: "#4c8dff",
      cursorAccent: "#12181f",
      selectionBackground: "#2b3a52",
      ...ANSI_TERMINUS,
    },
  },
  navy: {
    label: "Termez Navy",
    theme: {
      background: "#0e131c",
      foreground: "#e6edf3",
      cursor: "#4c8dff",
      selectionBackground: "#264f78",
      ...ANSI_TERMINUS,
    },
  },
  dark: {
    label: "Dark",
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#ffffff",
      selectionBackground: "#264f78",
      ...ANSI_TERMINUS,
    },
  },
  solarized: {
    label: "Solarized Dark",
    theme: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
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
      black: "#2e3436",
      red: "#cc0000",
      green: "#2e8b57",
      yellow: "#b58900",
      blue: "#1a6fd4",
      magenta: "#a347ba",
      cyan: "#0e8f8f",
      white: "#d3d7cf",
      brightBlack: "#555753",
      brightRed: "#ef2929",
      brightGreen: "#36a869",
      brightYellow: "#c4a000",
      brightBlue: "#3584e4",
      brightMagenta: "#c061cb",
      brightCyan: "#12b5b5",
      brightWhite: "#000000",
    },
  },
};

export const DEFAULT_THEME = "terminus";

export function resolveTheme(name: string | null | undefined): ITheme {
  return (name && TERM_THEMES[name]?.theme) || TERM_THEMES[DEFAULT_THEME].theme;
}
