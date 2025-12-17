from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect

from api.routes.media import router as media_router
from api.routes.preview import router as preview_router
from api.routes.project import router as project_router
from api.routes.render import router as render_router
from api.websocket import manager
from utils.ffmpeg_path import verify_ffmpeg
from utils.gpu_accel import detect_gpu_capabilities, print_gpu_info

@asynccontextmanager
async def lifespan(app: FastAPI):
    success, info = verify_ffmpeg()
    app.state.ffmpeg_ok = bool(success)
    app.state.ffmpeg_info = info

    base_dir = Path(__file__).resolve().parent
    temp_dir = base_dir / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    app.state.temp_dir = str(temp_dir)

    yield


app = FastAPI(title="Sparta Remix Visual Editor Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(project_router)
app.include_router(media_router)
app.include_router(render_router)
app.include_router(preview_router)


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health")
def health() -> dict[str, str | bool | dict]:
    ffmpeg_ok = bool(getattr(app.state, "ffmpeg_ok", False))
    caps = detect_gpu_capabilities()
    return {
        "status": "ok",
        "ffmpeg": ffmpeg_ok,
        "gpu": {
            "nvidia": caps.has_nvidia,
            "cuda": caps.has_cuda,
            "nvenc_h264": caps.has_nvenc_h264,
            "nvenc_hevc": caps.has_nvenc_hevc,
            "nvdec": caps.has_nvdec,
            "qsv": caps.has_qsv,
            "amf": caps.has_amf,
        },
    }


@app.get("/gpu-status")
def gpu_status() -> dict[str, str | bool]:
    """Detailed GPU acceleration status."""
    caps = detect_gpu_capabilities()
    return {
        "nvidia_detected": caps.has_nvidia,
        "cuda_available": caps.has_cuda,
        "hw_decode_available": caps.can_hw_decode,
        "hw_encode_h264": caps.can_hw_encode_h264,
        "hw_encode_hevc": caps.can_hw_encode_hevc,
        "nvenc_h264": caps.has_nvenc_h264,
        "nvenc_hevc": caps.has_nvenc_hevc,
        "nvdec": caps.has_nvdec,
        "intel_qsv": caps.has_qsv,
        "amd_amf": caps.has_amf,
        "info": print_gpu_info(),
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    await websocket.send_text("connected")
    try:
        while True:
            payload = await websocket.receive_text()
            await websocket.send_text(payload)
    except WebSocketDisconnect:
        await manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8765)
