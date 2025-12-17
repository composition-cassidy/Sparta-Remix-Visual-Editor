from __future__ import annotations


class VideoProcessor:
    def __init__(self, temp_dir: str) -> None:
        self.temp_dir = temp_dir

    def probe(self, media_path: str) -> dict[str, str]:
        raise NotImplementedError()
