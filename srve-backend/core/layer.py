from __future__ import annotations

from pydantic import BaseModel


class Layer(BaseModel):
    id: str
    name: str | None = None
    kind: str | None = None
