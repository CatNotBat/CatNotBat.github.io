# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26"]
# ///
"""Average spectrum of a WAV, for the harmonium station.

Record what Discord actually carries while harmonium is talking (any 16-bit
mono/stereo WAV works), then:

    uv run tools/wav_spectrum.py call.wav > data/harmonium.json

The site draws this instead of its illustration, and its caption stops
saying "an illustration".
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            sys.exit("16-bit PCM WAV only")
        rate, ch = w.getframerate(), w.getnchannels()
        x = (
            np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
            / 32768
        )
    return x.reshape(-1, ch).mean(axis=1), rate


def welch(x: np.ndarray, n: int = 2048) -> np.ndarray:
    win = np.hanning(n).astype(np.float32)
    frames = [x[i : i + n] * win for i in range(0, x.size - n, n // 2)]
    if not frames:
        sys.exit("recording is too short")
    return np.mean([np.abs(np.fft.rfft(f)) ** 2 for f in frames], axis=0)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("wav", type=Path)
    ap.add_argument("--fmax", type=float, default=4000.0, help="top of the plot in Hz")
    ap.add_argument("--points", type=int, default=121)
    args = ap.parse_args()

    x, rate = read_wav(args.wav)
    psd = welch(x)
    freqs = np.fft.rfftfreq(2048, 1 / rate)
    keep = freqs <= args.fmax
    db = 10 * np.log10(psd[keep] + 1e-12)
    edges = np.linspace(0, db.size, args.points + 1).astype(int)
    pooled = np.array(
        [db[a : max(b, a + 1)].max() for a, b in itertools.pairwise(edges)]
    )
    lo, hi = np.percentile(pooled, 5), pooled.max()
    level = np.clip((pooled - lo) / max(hi - lo, 1e-6), 0, 1)

    json.dump(
        {
            "kind": "wav",
            "rate": rate,
            "f_max": args.fmax,
            "seconds": round(x.size / rate, 1),
            "level": [round(float(v), 3) for v in level],
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
