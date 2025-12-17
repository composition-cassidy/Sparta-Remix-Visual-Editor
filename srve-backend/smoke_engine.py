from __future__ import annotations

import sys
from pathlib import Path

from core.midi_parser import parse_midi
from core.project import FlipMode, Layer, Project, SourceVideo, VideoClipSettings
from core.renderer import RenderEngine


def main() -> None:
    midi_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not midi_path or not midi_path.exists():
        raise SystemExit("Usage: python smoke_engine.py path/to/file.mid [midi_channel]")

    midi_channel = 1
    if len(sys.argv) > 2:
        try:
            midi_channel = int(sys.argv[2])
        except ValueError:
            raise SystemExit("midi_channel must be an integer 1..16")

    if midi_channel < 1 or midi_channel > 16:
        raise SystemExit("midi_channel must be between 1 and 16")

    midi = parse_midi(str(midi_path))

    # Minimal project with one source video and one layer
    video = SourceVideo(
        id="vid1",
        name="Dummy",
        path="dummy.mp4",
        duration_ms=10_000,  # 10s
        width=1920,
        height=1080,
        fps=30.0,
        codec="h264",
    )

    layer = Layer(
        id="layer1",
        name="Layer 1",
        source_video_id="vid1",
        midi_channel=midi_channel,  # IMPORTANT: must match your MIDI notes channel (1..16)
        clip_settings=VideoClipSettings(
            in_point_ms=0,
            out_point_ms=3_000,         # try small value to test looping quickly
            loop_mode="crossfade",      # try: "freeze" | "continue" | "crossfade"
        ),
        grid_position=(0, 0),
        use_global_grid=True,
        custom_grid=None,
        flip_mode=FlipMode.ROTATION_CW,  # try: NONE | ALTERNATING | ROTATION_CW | ROTATION_CCW
        velocity_opacity=True,
        note_length_mode="16th",         # try: "midi" | "4th" | "8th" | "16th" | "32nd"
        order=0,
        enabled=True,
    )

    project = Project(
        name="Smoke Test",
        source_videos=[video],
        layers=[layer],
        bpm=midi.bpm,  # or set explicit BPM here
    )

    engine = RenderEngine(project, midi)
    clips_by_layer = engine.generate_all_clips()

    clips = clips_by_layer.get("layer1", [])
    print(f"MIDI bpm={midi.bpm} duration_ms={midi.duration_ms}")
    channels_with_notes = sorted(
        ((ch, len(notes)) for ch, notes in midi.channels.items() if notes),
        key=lambda x: x[0],
    )
    print("Channels with notes:")
    for ch, count in channels_with_notes:
        print(f"  ch{ch}: {count}")

    print(f"Selected channel: ch{midi_channel} (notes={len(midi.channels.get(midi_channel, []))})")
    print(f"Generated clips={len(clips)}")

    # Print first 10 clips
    for c in clips[:10]:
        print(
            f"idx={c.clip_index} start={c.start_ms} dur={c.duration_ms} "
            f"src={c.source_start_ms} vel={c.velocity} flip={c.flip_state}"
        )

    # Sanity checks
    assert all(c.duration_ms > 0 for c in clips), "Found a non-positive duration"
    assert all(c.start_ms >= 0 for c in clips), "Found a negative start_ms"
    assert all(0 <= c.velocity <= 127 for c in clips), "Velocity out of range"

    # start_ms should be non-decreasing if notes are sorted
    assert all(clips[i].start_ms <= clips[i + 1].start_ms for i in range(len(clips) - 1)), "start_ms not sorted"


if __name__ == "__main__":
    main()