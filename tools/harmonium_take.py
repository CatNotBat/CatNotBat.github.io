# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26"]
# ///
"""Turn one harmonium take into everything the site needs.

Two tracks of the same moment (16-bit or float WAV, same sample rate):
  voice.wav  what comes out of harmonium at the far end
  wire.wav   what Discord actually carried

    uv run tools/harmonium_take.py voice.wav wire.wav --start 2.5 --length 14

The easy way to get them, no call needed (48 kHz mono input):

    harmonium selftest --input numbers.wav --opus --output voice.wav --modem-output wire.wav

writes data/harmonium-voice.m4a, data/harmonium-wire.m4a and
data/harmonium.json, and points data/manifest.json at them.
"""

from __future__ import annotations

import argparse
import itertools
import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from wav_spectrum import welch

SITE = Path(__file__).resolve().parent.parent
DATA = SITE / "data"


def read(path: Path) -> tuple[np.ndarray, int]:
    """16-bit PCM or 32-bit float WAV (harmonium writes float), any channel count."""
    raw = path.read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        sys.exit(f"{path.name}: not a WAV file")
    fmt: tuple[int, int, int, int] | None = None
    i = 12
    while i + 8 <= len(raw):
        cid, size = raw[i : i + 4], int.from_bytes(raw[i + 4 : i + 8], "little")
        body = raw[i + 8 : i + 8 + size]
        if cid == b"fmt ":
            tag = int.from_bytes(body[0:2], "little")
            if (
                tag == 0xFFFE
            ):  # WAVE_FORMAT_EXTENSIBLE: real tag is in the sub-format GUID
                tag = int.from_bytes(body[24:26], "little")
            fmt = (
                tag,
                int.from_bytes(body[2:4], "little"),
                int.from_bytes(body[4:8], "little"),
                int.from_bytes(body[14:16], "little"),
            )
        elif cid == b"data" and fmt:
            tag, ch, rate, bits = fmt
            if tag == 1 and bits == 16:
                x = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768
            elif tag == 3 and bits == 32:
                x = np.frombuffer(body, dtype="<f4").astype(np.float32)
            else:
                sys.exit(f"{path.name}: 16-bit PCM or 32-bit float WAV only")
            return x[: x.size - x.size % ch].reshape(-1, ch).mean(axis=1), rate
        i += 8 + size + (size & 1)
    sys.exit(f"{path.name}: no audio data found")


def shape(x: np.ndarray, rate: int, start: float, length: float) -> np.ndarray:
    a, b = int(start * rate), int((start + length) * rate)
    if b > x.size:
        sys.exit(f"take is only {x.size / rate:.1f} s long")
    y = x[a:b].copy()
    fade = int(0.03 * rate)
    ramp = np.linspace(0, 1, fade, dtype=np.float32)
    y[:fade] *= ramp
    y[-fade:] *= ramp[::-1]
    peak = float(np.abs(y).max()) or 1.0
    return y * (0.89 / peak)  # -1 dBFS


def write_wav(path: Path, y: np.ndarray, rate: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def encode(src: Path, stem: str) -> str:
    """m4a when the Mac (afconvert) or ffmpeg can make one, else plain WAV."""
    out = DATA / f"{stem}.m4a"
    for tool, cmd in (
        ("afconvert", ["afconvert", "-f", "m4af", "-d", "aac", str(src), str(out)]),
        (
            "ffmpeg",
            [
                "ffmpeg",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                str(out),
            ],
        ),
    ):
        if (
            shutil.which(tool)
            and subprocess.run(cmd, check=False, capture_output=True).returncode == 0
        ):
            return out.name
    out.unlink(missing_ok=True)
    wav = DATA / f"{stem}.wav"
    shutil.copy(src, wav)
    return wav.name


def spectrum(
    y: np.ndarray, rate: int, fmax: float = 4000.0, points: int = 121
) -> dict[str, object]:
    psd = welch(y)
    keep = np.fft.rfftfreq(2048, 1 / rate) <= fmax
    db = 10 * np.log10(psd[keep] + 1e-12)
    edges = np.linspace(0, db.size, points + 1).astype(int)
    pooled = np.array(
        [db[a : max(b, a + 1)].max() for a, b in itertools.pairwise(edges)]
    )
    lo, hi = np.percentile(pooled, 5), pooled.max()
    level = np.clip((pooled - lo) / max(hi - lo, 1e-6), 0, 1)
    return {
        "kind": "wav",
        "rate": rate,
        "f_max": fmax,
        "seconds": round(y.size / rate, 1),
        "level": [round(float(v), 3) for v in level],
    }


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("voice", type=Path)
    ap.add_argument("wire", type=Path)
    ap.add_argument("--start", type=float, default=0.0, help="seconds into both takes")
    ap.add_argument("--length", type=float, default=14.0)
    ap.add_argument("--note", default="", help="caption shown under the spectrum")
    ap.add_argument(
        "--voice-offset",
        type=float,
        default=0.0,
        help="seconds the decoded voice lags the wire (selftest prints it as latency)",
    )
    args = ap.parse_args()

    voice, vr = read(args.voice)
    wire, wr = read(args.wire)
    if vr != wr:
        sys.exit(f"sample rates differ ({vr} vs {wr}); record both at the same rate")
    v = shape(voice, vr, args.start + args.voice_offset, args.length)
    w = shape(wire, wr, args.start, args.length)

    DATA.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tv, tw = Path(tmp, "voice.wav"), Path(tmp, "wire.wav")
        write_wav(tv, v, vr)
        write_wav(tw, w, wr)
        files = {
            "voice": encode(tv, "harmonium-voice"),
            "wire": encode(tw, "harmonium-wire"),
        }
    spec = spectrum(w, wr)
    if args.note:
        spec["note"] = args.note
    (DATA / "harmonium.json").write_text(json.dumps(spec))

    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest.update({"harmonium": "harmonium.json", "harmonium_audio": files})
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    print(
        f"ok: {files['voice']}, {files['wire']}, harmonium.json ({args.length:.1f} s at {vr} Hz)"
    )


if __name__ == "__main__":
    main()
