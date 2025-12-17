from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/project", tags=["project"])


@router.post("/save")
def save_project(payload: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(status_code=501, detail="Not implemented")


@router.post("/load")
def load_project(payload: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(status_code=501, detail="Not implemented")
