// SPIKE: khi chạy trong Electron, giả lập lớp `window.__TAURI_INTERNALS__` mà
// @tauri-apps/api dùng bên dưới (invoke, Channel, listen, cửa sổ). Nhờ vậy toàn
// bộ giao diện chạy nguyên văn, không phải sửa từng chỗ gọi Tauri.
// Chạy trong Tauri thì file này không làm gì.

type Bridge = {
  invoke: (cmd: string, args: unknown) => Promise<{ ok?: unknown; __err?: string }>;
  onChannel: (cb: (m: { id: number; index: number; message: Uint8Array }) => void) => void;
  onEvent: (cb: (m: { event: string; payload: unknown }) => void) => void;
};

const bridge = (window as unknown as { tzElectron?: Bridge }).tzElectron;

if (bridge) {
  const callbacks = new Map<number, (data: unknown) => void>();
  let nextCallbackId = 1;
  // event → (eventId → callbackId)
  const listeners = new Map<string, Map<number, number>>();
  let nextEventId = 1;

  const transformCallback = (cb?: (d: unknown) => void, once = false) => {
    const id = nextCallbackId++;
    callbacks.set(id, (d) => {
      if (once) callbacks.delete(id);
      cb?.(d);
    });
    return id;
  };
  const unregisterCallback = (id: number) => {
    callbacks.delete(id);
  };

  // Output terminal → Channel (Channel tự sắp lại thứ tự theo index).
  bridge.onChannel((m) => callbacks.get(m.id)?.({ message: m.message, index: m.index }));
  // Sự kiện backend (ssh:closed, ssh:latency…) → các listener đã đăng ký.
  bridge.onEvent((m) => {
    const ls = listeners.get(m.event);
    if (!ls) return;
    for (const [eventId, cbId] of ls) callbacks.get(cbId)?.({ event: m.event, id: eventId, payload: m.payload });
  });

  async function invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === "plugin:event|listen") {
      const event = args.event as string;
      const eventId = nextEventId++;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event)!.set(eventId, args.handler as number);
      return eventId;
    }
    if (cmd === "plugin:event|unlisten") {
      listeners.get(args.event as string)?.delete(args.eventId as number);
      return;
    }
    // JSON hoá để Channel tự biến thành "__CHANNEL__:<id>" như Tauri làm.
    const plain = JSON.parse(JSON.stringify(args ?? {}));
    const res = await bridge!.invoke(cmd, plain);
    if (res && "__err" in res) throw res.__err; // Tauri reject bằng chuỗi
    return res?.ok;
  }

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback,
    unregisterCallback,
    invoke,
    convertFileSrc: (p: string) => p,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => listeners.get(event)?.delete(eventId),
  };

  // Vùng kéo cửa sổ: Tauri dùng thuộc tính data-tauri-drag-region.
  const style = document.createElement("style");
  style.textContent =
    "[data-tauri-drag-region]{-webkit-app-region:drag}" +
    "[data-tauri-drag-region] button,[data-tauri-drag-region] input{-webkit-app-region:no-drag}";
  document.head.appendChild(style);
}

export {};
