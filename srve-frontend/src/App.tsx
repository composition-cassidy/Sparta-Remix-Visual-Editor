import { useEffect, useState } from 'react';

import { checkHealth, type HealthResponse } from './api/client';
import {
  closeWebSocket,
  connectWebSocket,
  onWebSocketStatusChange,
  type WebSocketStatus,
} from './api/websocket';
import { MainLayout } from './components/Layout/MainLayout';

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>('disconnected');

  useEffect(() => {
    let cancelled = false;

    checkHealth()
      .then((data) => {
        if (cancelled) return;
        setHealth(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setHealthError(message);
      });

    connectWebSocket();
    const unsubscribe = onWebSocketStatusChange(setWsStatus);

    return () => {
      cancelled = true;
      unsubscribe();
      closeWebSocket();
    };
  }, []);

  if (healthError) {
    return (
      <div className="h-full w-full bg-srve-bg text-gray-200 flex items-center justify-center p-6">
        <div className="max-w-xl w-full bg-srve-panel border border-white/10 rounded p-6">
          <div className="text-lg font-semibold">Backend connection failed</div>
          <div className="mt-2 text-sm text-gray-300">{healthError}</div>
          <div className="mt-4 text-sm text-gray-400">
            The SRVE backend must be running on <span className="text-gray-200">http://localhost:8765</span>.
          </div>
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="h-full w-full bg-srve-bg text-gray-200 flex items-center justify-center">
        <div className="text-sm text-gray-300">Connecting to backend...</div>
      </div>
    );
  }

  const connected = wsStatus === 'connected';
  const dotColor = connected ? 'bg-green-500' : 'bg-red-500';

  return (
    <div className="h-full w-full">
      <MainLayout />

      <div className="fixed bottom-4 right-4 bg-srve-panel border border-white/10 rounded px-3 py-2 text-sm flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        <span className="text-gray-200">{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="text-gray-500">|</span>
        <span className="text-gray-200">{health.ffmpeg ? 'FFmpeg: OK' : 'FFmpeg: NOT FOUND'}</span>
      </div>
    </div>
  );
}
