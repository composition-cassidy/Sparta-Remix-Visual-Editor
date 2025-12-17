from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import mido
from pydantic import BaseModel, Field


class MidiNote(BaseModel):
    start_ms: int
    end_ms: int
    note: int = Field(ge=0, le=127)
    velocity: int = Field(ge=0, le=127)
    duration_ms: int


class MidiData(BaseModel):
    bpm: float = 120.0
    duration_ms: int = 0
    channels: dict[int, list[MidiNote]] = Field(default_factory=dict)


def parse_midi(path: str) -> MidiData:
    midi_path = Path(path)
    if not midi_path.exists():
        raise FileNotFoundError(f"MIDI file not found: {midi_path}")

    mid = mido.MidiFile(str(midi_path))

    first_tempo: int | None = None
    current_time_s = 0.0
    channels: dict[int, list[MidiNote]] = defaultdict(list)
    active: dict[int, dict[int, list[tuple[int, int]]]] = defaultdict(lambda: defaultdict(list))

    for msg in mid:
        current_time_s += float(getattr(msg, "time", 0.0) or 0.0)

        if msg.type == "set_tempo" and first_tempo is None:
            first_tempo = int(msg.tempo)

        if msg.type == "note_on" and int(msg.velocity) > 0:
            channel = int(msg.channel) + 1
            note = int(msg.note)
            velocity = int(msg.velocity)
            start_ms = int(round(current_time_s * 1000.0))
            active[channel][note].append((start_ms, velocity))
            continue

        is_note_off = msg.type == "note_off" or (msg.type == "note_on" and int(msg.velocity) == 0)
        if is_note_off:
            channel = int(msg.channel) + 1
            note = int(msg.note)
            end_ms = int(round(current_time_s * 1000.0))
            stack = active[channel].get(note)
            if not stack:
                continue
            start_ms, velocity = stack.pop()
            duration_ms = max(0, end_ms - start_ms)
            channels[channel].append(
                MidiNote(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    note=note,
                    velocity=velocity,
                    duration_ms=duration_ms,
                )
            )

    for notes in channels.values():
        notes.sort(key=lambda n: n.start_ms)

    bpm = float(mido.tempo2bpm(first_tempo)) if first_tempo is not None else 120.0
    duration_ms = int(round(current_time_s * 1000.0))

    return MidiData(bpm=bpm, duration_ms=duration_ms, channels=dict(channels))
