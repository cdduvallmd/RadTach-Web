export type GooseAction = 'stop' | 'search';

export interface GooseMessage {
  action: GooseAction;
  text?: string;
}

const WS_URL = 'ws://127.0.0.1:9473';
const MAX_BACKOFF = 16_000;

// Module-level reference for sendToGoose
let _activeWs: WebSocket | null = null;

export function sendToGoose(msg: object): void {
  if (_activeWs && _activeWs.readyState === WebSocket.OPEN) {
    _activeWs.send(JSON.stringify(msg));
  }
}

export function connectToGoose(
  onMessage: (msg: GooseMessage) => void,
  onStatusChange: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function connect() {
    if (disposed) return;

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = 1000;
      _activeWs = ws;
      onStatusChange(true);
    };

    ws.onclose = () => {
      if (_activeWs === ws) _activeWs = null;
      onStatusChange(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires after onerror, reconnect handled there
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as GooseMessage;
        if (msg.action === 'stop' || msg.action === 'search') {
          onMessage(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    };
  }

  function scheduleReconnect() {
    if (disposed) return;
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      connect();
    }, backoff);
  }

  function cleanup() {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      if (_activeWs === ws) _activeWs = null;
      ws.onclose = null;
      ws.close();
    }
  }

  connect();
  return cleanup;
}
