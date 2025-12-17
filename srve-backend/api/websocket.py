from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._active_connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._active_connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._active_connections.discard(websocket)

    async def broadcast_text(self, message: str) -> None:
        async with self._lock:
            connections = list(self._active_connections)

        for websocket in connections:
            await websocket.send_text(message)

    async def broadcast_json(self, payload: Any) -> None:
        async with self._lock:
            connections = list(self._active_connections)

        for websocket in connections:
            await websocket.send_json(payload)


manager = ConnectionManager()
