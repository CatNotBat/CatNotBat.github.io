# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26"]
# ///
"""Turn an rtl_power sweep into the static the site plays between stations.

On the Pi, with an RTL-SDR plugged in:

    rtl_power -f 88M:108M:20k -g 40 -i 1 -e 5m sweep.csv
    uv run tools/sdr_static.py sweep.csv --place "Tel Aviv" > data/static.json

Each output row is one sweep: `width` bytes of power, 0 = the quietest bin
in the whole capture, 255 = the loudest. Nothing here is invented: if the
file is missing, the site falls back to its own random noise.
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import itertools
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np


def read_sweeps(path: Path) -> tuple[list[np.ndarray], float, float]:
    """Group rtl_power segments by timestamp into full-band sweeps."""
    segs: dict[str, list[tuple[float, np.ndarray]]] = defaultdict(list)
    lo, hi = float("inf"), 0.0
    with path.open(newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 7:
                continue
            stamp = f"{row[0].strip()} {row[1].strip()}"
            f_lo, f_hi = float(row[2]), float(row[3])
            db = np.array(
                [float(x) for x in row[6:] if x.strip() not in ("", "nan", "-nan")],
                dtype=np.float32,
            )
            if db.size == 0:
                continue
            segs[stamp].append((f_lo, db))
            lo, hi = min(lo, f_lo), max(hi, f_hi)
    sweeps = [
        np.concatenate([db for _, db in sorted(parts, key=lambda p: p[0])])
        for _, parts in sorted(segs.items())
    ]
    if not sweeps:
        sys.exit("no sweeps found; is this an rtl_power CSV?")
    n = min(s.size for s in sweeps)
    return [s[:n] for s in sweeps], lo, hi


def resample(row: np.ndarray, width: int) -> np.ndarray:
    """Max-pool into `width` columns so narrow carriers survive."""
    edges = np.linspace(0, row.size, width + 1).astype(int)
    return np.array(
        [row[a : max(b, a + 1)].max() for a, b in itertools.pairwise(edges)],
        dtype=np.float32,
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("csv", type=Path)
    ap.add_argument("--place", default="")
    ap.add_argument("--width", type=int, default=240)
    ap.add_argument(
        "--rows", type=int, default=120, help="keep at most this many sweeps"
    )
    args = ap.parse_args()

    sweeps, lo, hi = read_sweeps(args.csv)
    step = max(1, len(sweeps) // args.rows)
    grid = np.stack([resample(s, args.width) for s in sweeps[::step][: args.rows]])
    floor, peak = np.percentile(grid, 2), np.percentile(grid, 99.8)
    q = np.clip((grid - floor) / max(peak - floor, 1e-6), 0, 1)
    rows = (q * 255).astype(np.uint8)

    json.dump(
        {
            "kind": "rtl_power",
            "place": args.place,
            "captured": dt.datetime.fromtimestamp(args.csv.stat().st_mtime)
            .date()
            .isoformat(),
            "f_lo": lo,
            "f_hi": hi,
            "width": args.width,
            "rows": [base64.b64encode(r.tobytes()).decode() for r in rows],
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
