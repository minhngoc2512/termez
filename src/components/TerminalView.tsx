import { useEffect, useRef } from "react";
import * as pool from "../lib/terminalPool";

interface Props {
  panelId: string;
  hostId: string;
  themeName?: string | null;
  fontSize?: number | null;
}

/**
 * Điểm gắn cho terminal. Bản thân xterm + phiên SSH sống trong terminalPool
 * (không phụ thuộc mount/unmount của pane) nên đổi workspace / di chuyển pane
 * KHÔNG ngắt phiên. Đây chỉ là chỗ để gắn/gỡ DOM.
 */
export function TerminalView({ panelId, hostId, themeName, fontSize }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    pool.acquire(panelId, hostId, themeName ?? null, fontSize ?? null);
    pool.attach(panelId, mount);
    return () => {
      // Chỉ gỡ DOM — GIỮ phiên sống (release chỉ khi panel bị đóng hẳn).
      pool.detach(panelId, mount);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  return <div ref={ref} className="h-full w-full" />;
}
