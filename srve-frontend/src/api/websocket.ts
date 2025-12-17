export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected';

type StatusHandler = (status: WebSocketStatus) => void;
type MessageHandler = (message: string) => void;

const WS_URL = 'ws://localhost:8765/ws';
const RECONNECT_DELAY_MS = 3000;

let socket: WebSocket | null = null;
let status: WebSocketStatus = 'disconnected';
let reconnectTimerId: number | null = null;
let manuallyClosed = false;

const statusHandlers = new Set<StatusHandler>();
const messageHandlers = new Set<MessageHandler>();

function setStatus(next: WebSocketStatus) {
  status = next;
  for (const handler of statusHandlers) {
    handler(status);
  }
}

function scheduleReconnect() {
  if (reconnectTimerId != null) {
    return;
  }

  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null;
    if (!manuallyClosed) {
      connectWebSocket();
    }
  }, RECONNECT_DELAY_MS);
}

export function getWebSocketStatus(): WebSocketStatus {
  return status;
}

export function onWebSocketStatusChange(handler: StatusHandler): () => void {
  statusHandlers.add(handler);
  handler(status);
  return () => {
    statusHandlers.delete(handler);
  };
}

export function onWebSocketMessage(handler: MessageHandler): () => void {
  messageHandlers.add(handler);
  return () => {
    messageHandlers.delete(handler);
  };
}

export function connectWebSocket(): void {
  if (socket && (status === 'connected' || status === 'connecting')) {
    return;
  }

  if (reconnectTimerId != null) {
    window.clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }

  manuallyClosed = false;
  setStatus('connecting');

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    setStatus('connected');
  };

  socket.onmessage = (event) => {
    const message = typeof event.data === 'string' ? event.data : String(event.data);
    for (const handler of messageHandlers) {
      handler(message);
    }
  };

  socket.onerror = () => {};

  socket.onclose = () => {
    socket = null;
    setStatus('disconnected');
    if (!manuallyClosed) {
      scheduleReconnect();
    }
  };
}

export function closeWebSocket(): void {
  manuallyClosed = true;
  if (reconnectTimerId != null) {
    window.clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  setStatus('disconnected');
}
