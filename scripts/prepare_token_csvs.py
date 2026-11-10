#!/usr/bin/env python3
"""Convert per-token 1-minute OHLCV CSV files to static OpenCharts datasets.
Run from repository root: python3 scripts/prepare_token_csvs.py /path/to/csvs
This script does not edit or delete the original CSVs.
"""
import argparse
import csv
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
from pathlib import Path
import re

REQUIRED = {"unix", "open", "high", "low", "close", "volume_usd", "event"}


def parse_number(value: str, label: str, path: Path, line: int) -> float:
    try:
        result = float(Decimal(value.strip()))
    except (ValueError, InvalidOperation, AttributeError):
        raise ValueError(f"{path}:{line}: invalid {label}: {value!r}") from None
    if not math.isfinite(result):
        raise ValueError(f"{path}:{line}: non-finite {label}")
    return result


def convert(path: Path, output: Path, timestamps_at_end: bool) -> dict:
    stem = path.stem
    slug = re.sub(r"[^A-Z0-9]+", "_", stem.upper()).strip("_")[:42] or "TOKEN"
    suffix = hashlib.sha256(path.name.encode("utf-8")).hexdigest()[:8].upper()
    symbol = f"CSV_{slug}_{suffix}"
    bars = []
    events = []
    misaligned = 0
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not REQUIRED.issubset(set(reader.fieldnames)):
            raise ValueError(f"{path}: missing required columns {sorted(REQUIRED - set(reader.fieldnames or []))}")
        for line, row in enumerate(reader, 2):
            raw_time = parse_number(row["unix"], "unix", path, line)
            seconds = raw_time / 1000 if raw_time >= 1e12 else raw_time
            if timestamps_at_end:
                seconds -= 60
            if seconds % 60 != 0:
                misaligned += 1
            t = int(seconds // 60) * 60
            o, h, l, c = (parse_number(row[k], k, path, line) for k in ("open", "high", "low", "close"))
            vol = parse_number(row.get("volume_usd") or "0", "volume_usd", path, line)
            if min(o, h, l, c) <= 0 or vol < 0 or h < max(o, l, c) or l > min(o, h, c):
                raise ValueError(f"{path}:{line}: invalid OHLC or negative volume")
            bars.append({"time": t, "open": o, "high": h, "low": l, "close": c, "volume": vol})
            event = (row.get("event") or "").strip()
            if event:
                events.append({"time": t, "event": event, "min_from_entry": (row.get("min_from_entry") or "").strip()})
    if not bars:
        raise ValueError(f"{path}: no rows")
    bars.sort(key=lambda b: b["time"])
    if any(a["time"] == b["time"] for a, b in zip(bars, bars[1:])):
        raise ValueError(f"{path}: duplicate 1-minute timestamps (possibly duplicate CSV rows)")
    events.sort(key=lambda e: e["time"])
    # More digits than typical coins, up to the practical range of JS float display.
    smallest = min(b["low"] for b in bars)
    digits = max(5, min(15, -math.floor(math.log10(smallest)) + 3))
    tick = 10 ** (-digits)
    output.joinpath(f"{symbol}.json").write_text(
        json.dumps({"candles": bars, "events": events}, separators=(",", ":")), encoding="utf-8"
    )
    if misaligned:
        print(f"  NOTE {stem}: rounded {misaligned} timestamps to minute starts")
    print(f"  {stem}: {len(bars)} candles, {len(events)} events -> {symbol}")
    return {"symbol": symbol, "displayName": stem, "tickSize": tick,
            "bars": len(bars), "events": len(events), "firstTime": bars[0]["time"],
            "lastTime": bars[-1]["time"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Directory containing token CSV files")
    parser.add_argument("--output", type=Path, default=Path("public/historical"))
    parser.add_argument("--timestamp-end", action="store_true", help="CSV unix is the candle END time rather than start")
    args = parser.parse_args()
    if not args.source.is_dir():
        parser.error(f"not a directory: {args.source}")
    paths = sorted(args.source.glob("*.csv"))
    if not paths:
        parser.error(f"no .csv files found directly in {args.source}")
    args.output.mkdir(parents=True, exist_ok=True)
    index = [convert(p, args.output, args.timestamp_end) for p in paths]
    args.output.joinpath("manifest.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"Wrote {len(index)} token datasets and {args.output / 'manifest.json'}")


if __name__ == "__main__":
    main()
