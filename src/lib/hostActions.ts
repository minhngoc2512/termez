import { Host } from "./ipc";

/** App gán `open` trong effect; các view khác (vault) gọi để mở terminal SSH. */
export const hostActions: { open: (h: Host) => void } = {
  open: () => {},
};
