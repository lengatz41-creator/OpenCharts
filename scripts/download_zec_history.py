#!/usr/bin/env python3
"""Fetch Binance Spot ZECUSDT monthly klines and write CSV for the prior
OpenCharts CSV historical adapter. Standard-library only.

Examples:
  python3 download_zec_history.py --interval 1h --start 2019-01 --end 2026-10 \
      --output /tmp/zec-csv/ZECUSDT_full_1h.csv
  python3 download_zec_history.py --interval 1m --start 2025-08 --end 2025-08 \
      --output /tmp/zec-csv/ZECUSDT_2025-08_1m.csv --events /tmp/zec_entries.csv

NOTE: Prices and quote asset volume are in USDT; the CSV header `volume_usd`
is used solely for compatibility with the previously supplied converter.
"""

import argparse
import csv
from datetime import datetime, timezone
from io import BytesIO, TextIOWrapper
import math
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import zipfile

SYMBOL = "ZECUSDT"
ARCHIVE_ROOT = "https://data.binance.vision/data/spot/monthly/klines"
HEADER = ["unix", "time_utc", "open", "high", "low", "close", "volume_usd", "min_from_entry", "event"]
INTERVAL_SECONDS = {"1m": 60, "15m": 900, "1h": 3600}


def parse_month(s):
    try:
        d = datetime.strptime(s, "%Y-%m")
        if d.strftime("%Y-%m") != s:
            raise ValueError
        return d.year, d.month
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected YYYY-MM") from exc


def months(start, end):
    y, m = start
    while (y, m) <= end:
        yield f"{y:04d}-{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def to_seconds(raw):
    ts = int(raw)
    if ts >= 100_000_000_000_000:  # Binance SPOT archives from 2025-01: us
        return ts // 1_000_000
    if ts >= 100_000_000_000:  # older archives: ms
        return ts // 1_000
    return ts


def parse_event_time(row):
    raw = (row.get("unix") or "").strip()
    if raw:
        return to_seconds(raw)
    s = (row.get("time_utc") or "").strip()
    if not s:
        raise ValueError("Event row lacks both unix and time_utc")
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def read_events(path, seconds):
    if path is None:
        return {}
    events = {}
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "event" not in reader.fieldnames:
            raise ValueError("--events file must have an `event` column")
        for lineno, row in enumerate(reader, start=2):
            label = (row.get("event") or "").strip()
            if not label:
                continue
            if label.lower() not in ("entry", "partial_sell", "runner_floor", "stop") and \
               not any(t in label.lower() for t in ("stop", "exit", "floor")):
                print(f"NOTE: preserving custom event {label!r} (row {lineno})")
            ts = parse_event_time(row)
            bucket = (ts // seconds) * seconds
            if bucket in events:
                prev = events[bucket]["event"]
                raise ValueError(
                    f"Multiple events fall in the same {seconds // 60}-minute candle at "
                    f"{datetime.fromtimestamp(bucket, timezone.utc).isoformat()}: "
                    f"{prev!r}, {label!r}. Use 1m data or an event sidecar that supports "
                    "multiple markers per candle; no events were discarded."
                )
            events[bucket] = {
                "event": label,
                "min_from_entry": (row.get("min_from_entry") or "").strip(),
            }
    return events


def get_archive(interval, month, cache_dir):
    filename = f"{SYMBOL}-{interval}-{month}.zip"
    cache_path = cache_dir / filename
    if cache_path.exists():
        return cache_path.read_bytes()
    url = f"{ARCHIVE_ROOT}/{SYMBOL}/{interval}/{filename}"
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"User-Agent": "OpenCharts-History-Loader/1.0"}), timeout=60) as r:
                data = r.read()
            if not zipfile.is_zipfile(BytesIO(data)):
                raise ValueError(f"Archive is not a valid ZIP: {url}")
            cache_path.write_bytes(data)
            return data
        except HTTPError as exc:
            if exc.code == 404:
                print(f"  Missing (404): {month} {interval} — skipping")
                return None
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"HTTP {exc.code} fetching {url}") from exc
        except URLError as exc:
            if attempt == 2:
                raise RuntimeError(f"Network error fetching {url}: {exc}") from exc
        time.sleep(1 + attempt * 2)
    raise RuntimeError(f"Unable to fetch {url}")


def rows_in_archive(archive, interval):
    seconds = INTERVAL_SECONDS[interval]
    with zipfile.ZipFile(BytesIO(archive)) as z:
        files = [n for n in z.namelist() if n.endswith(".csv")]
        if len(files) != 1:
            raise ValueError(f"Expected one CSV within ZIP, got {files}")
        with z.open(files[0]) as binary:
            for row in csv.reader(TextIOWrapper(binary, encoding="utf-8-sig", newline="")):
                if not row or row[0].strip().lower() in ("open time", "open_time"):
                    continue
                if len(row) < 8:
                    raise ValueError(f"Archive row has fewer than 8 columns: {row}")
                try:
                    t = to_seconds(row[0])
                except ValueError as exc:
                    raise ValueError(f"Invalid archive timestamp {row[0]!r}") from exc
                if t % seconds != 0:
                    raise ValueError(f"Unexpected nonaligned candle time {t} for {interval}")
                o, h, l, c, quote_vol = map(float, (row[1], row[2], row[3], row[4], row[7]))
                if not all(math.isfinite(n) for n in (o, h, l, c, quote_vol)) or \
                   min(o, h, l, c) <= 0 or quote_vol < 0 or \
                   h < max(o, l, c) or l > min(o, h, c):
                    raise ValueError(f"Invalid OHLCV row at {t}")
                yield t, row[1], row[2], row[3], row[4], row[7]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", type=parse_month, required=True, help="First YYYY-MM month, inclusive")
    p.add_argument("--end", type=parse_month, required=True, help="Last YYYY-MM month, inclusive")
    p.add_argument("--interval", choices=list(INTERVAL_SECONDS), required=True)
    p.add_argument("--output", type=Path, required=True, help="OpenCharts-compatible output CSV")
    p.add_argument("--events", type=Path, help="Optional ZEC event CSV: unix/time_utc,event,min_from_entry")
    p.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache" / "zec-binance-monthly")
    args = p.parse_args()
    if args.start > args.end:
        p.error("--start must be before or equal to --end")
    if args.output.exists():
        p.error(f"Output exists; refusing to overwrite: {args.output}")
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    step = INTERVAL_SECONDS[args.interval]
    events = read_events(args.events, step)
    count = 0
    last = -1
    used_events = set()
    temp = args.output.with_suffix(args.output.suffix + ".partial")
    try:
        with temp.open("w", encoding="utf-8", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=HEADER)
            writer.writeheader()
            for month in months(args.start, args.end):
                archive = get_archive(args.interval, month, args.cache_dir)
                if archive is None:
                    continue
                monthly_rows = 0
                for t, o, h, l, c, qvol in rows_in_archive(archive, args.interval):
                    if t <= last:
                        raise ValueError(f"Duplicate or nonmonotonic candle at {t}; after {last}")
                    last = t
                    ev = events.get(t)
                    if ev:
                        used_events.add(t)
                    writer.writerow({
                        "unix": t,
                        "time_utc": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "open": o, "high": h, "low": l, "close": c,
                        "volume_usd": qvol,  # actually USDT quote volume
                        "min_from_entry": ev["min_from_entry"] if ev else "",
                        "event": ev["event"] if ev else "",
                    })
                    count += 1
                    monthly_rows += 1
                print(f"  {month} {args.interval}: {monthly_rows:,} candles")
        if count == 0:
            raise RuntimeError("No candles found in selected months; check archives/market availability")
        temp.replace(args.output)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    print(f"Wrote {count:,} candles to {args.output}")
    if args.events:
        print(f"Embedded {len(used_events):,}/{len(events):,} event markers.")
        remaining = len(events) - len(used_events)
        if remaining:
            print(f"WARNING: {remaining} events outside downloaded candle times or on missing candles; not embedded.")
    print("Reminder: Prices and `volume_usd` values are denominated in USDT, not actual USD.")


if __name__ == "__main__":
    main()
