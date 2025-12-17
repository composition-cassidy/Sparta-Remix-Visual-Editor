from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/render", tags=["render"])


@router.post("/start")
def start_render() -> dict[str, str]:
    raise HTTPException(status_code=501, detail="Not implemented")


@router.get("/status/{render_id}")
def render_status(render_id: str) -> dict[str, str]:
    raise HTTPException(status_code=501, detail="Not implemented")
