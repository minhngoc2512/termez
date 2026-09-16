import { create } from "zustand";
import { api, Group, Host, SshKey, Tunnel, VaultEntry } from "./lib/ipc";

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
  toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),
  setLocked: (b) => set({ locked: b }),
  refreshLock: async () => {
    try {
      const s = await api.applockStatus();
      set({ lockEnabled: s.enabled, lockTimeout: s.timeout_mins });
    } catch {
      set({ lockEnabled: false, lockTimeout: 0 });
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
