import { create } from "zustand";
import { api, Group, Host, SshKey, Tunnel, VaultEntry } from "./lib/ipc";
import { DEFAULT_THEME } from "./lib/themes";

export type AppTheme = "dark" | "light" | "system";

function resolveAppTheme(t: AppTheme): "dark" | "light" {
  if (t === "system") {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  }
  return t;
}
export function applyAppTheme(t: AppTheme) {
  try {
    document.documentElement.dataset.theme = resolveAppTheme(t);
  } catch {
    /* ngoài trình duyệt */
  }
}
function ls(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const initialAppTheme = ls("app-theme", "dark") as AppTheme;
applyAppTheme(initialAppTheme);

interface AppState {
  groups: Group[];
  hosts: Host[];
  keys: SshKey[];
  tunnels: Tunnel[];
  entries: VaultEntry[];
  vaultFolders: string[];
  loading: boolean;
  broadcast: boolean;
  locked: boolean;
  lockEnabled: boolean;
  lockTimeout: number; // phút; 0 = không tự khóa
  lockTotp: boolean;
  lockReauth: number; // phút; buộc xác thực lại (kể cả đang hoạt động)
  appTheme: AppTheme;
  termTheme: string;
  termFontSize: number;
  autoUpdate: boolean;
  setAutoUpdate: (b: boolean) => void;
  setAppTheme: (t: AppTheme) => void;
  setTermTheme: (t: string) => void;
  setTermFontSize: (n: number) => void;
  toggleBroadcast: () => void;
  setLocked: (b: boolean) => void;
  refreshLock: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useStore = create<AppState>((set) => ({
  groups: [],
  hosts: [],
  keys: [],
  tunnels: [],
  entries: [],
  vaultFolders: [],
  loading: false,
  broadcast: false,
  locked: false,
  lockEnabled: false,
  lockTimeout: 0,
  lockTotp: false,
  lockReauth: 0,
  appTheme: initialAppTheme,
  termTheme: ls("term-theme", DEFAULT_THEME),
  termFontSize: Number(ls("term-font-size", "13.5")) || 13.5,
  autoUpdate: ls("auto-update", "1") === "1",
  setAutoUpdate: (b) => { lsSet("auto-update", b ? "1" : "0"); set({ autoUpdate: b }); },
  setAppTheme: (t) => { lsSet("app-theme", t); applyAppTheme(t); set({ appTheme: t }); },
  setTermTheme: (t) => { lsSet("term-theme", t); set({ termTheme: t }); },
  setTermFontSize: (n) => { lsSet("term-font-size", String(n)); set({ termFontSize: n }); },
  toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),
  setLocked: (b) => set({ locked: b }),
  refreshLock: async () => {
    try {
      const s = await api.applockStatus();
      set({ lockEnabled: s.enabled, lockTimeout: s.timeout_mins, lockTotp: s.totp_enabled, lockReauth: s.reauth_mins });
    } catch {
      set({ lockEnabled: false, lockTimeout: 0, lockTotp: false, lockReauth: 0 });
    }
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const [groups, hosts, keys, tunnels, entries] = await Promise.all([
        api.getGroups(),
        api.getHosts(),
        api.getKeys(),
        api.getTunnels(),
        api.getEntries(),
      ]);
      // Không để lỗi (vd. backend cũ chưa có lệnh) chặn toàn bộ dữ liệu.
      const vaultFolders = await api.getVaultFolders().catch(() => [] as string[]);
      set({ groups, hosts, keys, tunnels, entries, vaultFolders });
    } catch (err) {
      console.error("refresh failed:", err);
    } finally {
      set({ loading: false });
    }
  },
}));
