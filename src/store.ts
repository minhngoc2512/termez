import { create } from "zustand";
import { api, Group, Host, SshKey, Tunnel, VaultEntry } from "./lib/ipc";

interface AppState {
  groups: Group[];
  hosts: Host[];
  keys: SshKey[];
  tunnels: Tunnel[];
  entries: VaultEntry[];
  loading: boolean;
  broadcast: boolean;
  toggleBroadcast: () => void;
  refresh: () => Promise<void>;
}

export const useStore = create<AppState>((set) => ({
  groups: [],
  hosts: [],
  keys: [],
  tunnels: [],
  entries: [],
  loading: false,
  broadcast: false,
  toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),

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
      set({ groups, hosts, keys, tunnels, entries });
    } catch (err) {
      console.error("refresh failed:", err);
    } finally {
      set({ loading: false });
    }
  },
}));
