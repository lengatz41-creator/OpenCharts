#!/usr/bin/env python3
"""Add chart-review lists (stage2/stage3 CSVs) to the CMC token data as "Review: ..." watchlist groups.

Each review row becomes its own chart (the referenced token's candles plus that row's markers),
so the same token can appear in several reviews with different markers.
Run after build-cmc-data.py (which keeps existing "Review:" entries when it rewrites symbols.json):
  python3 examples/cmc-tokens/build-review-data.py [/root/OpenCharts/cmc-data]"""
import csv, json, math, os, sys
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/root/OpenCharts/cmc-data")
REVIEW_DIR = Path("/root")
CHART_DIRS = [Path("/root/CMC_TOKEN_CHARTS/ohlcv"), Path("/root/CMC_TOKEN_CHARTS/real_trades/ohlcv")]
POLL_DIRS = [Path("/root/SUPER_BEAR_BOT_5000/data"), Path("/root/SUPER_BEAR_BOT_5000/olddata")]
CH = {"bsc": "BSC", "ethereum": "ETH", "eth": "ETH", "solana": "SOL"}
# Sells the bot never logged, traced on-chain (same table as build-cmc-data.py)
ONCHAIN_SELLS = {
    "ELIEN": (1778341257, -1.63),
    "小蝌蚪": (1780059971, -39.12),
    "RAGEGUY": (1780059984, -5.58),
    "TERMINUS": (1780062377, -7.16),
    "HOPPY": (1780062362, -3.22),
}


def sig(x, n=7):
    return float(f"{x:.{n}g}")


def fnum(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def pct(v):
    return "" if v is None else f" {v:+.1f}%"


def ts(s):
    if not s:
        return None
    d = datetime.fromisoformat(s.strip().replace("Z", "+00:00").replace(" ", "T", 1))
    return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())


def find(path):
    """Resolve a review CSV's file reference (a Mac path or zip-relative path) to a file here."""
    base = os.path.basename(path)
    for d in (POLL_DIRS if "live_price_polls" in path else CHART_DIRS):
        if (d / base).exists():
            return d / base
    return None


def load_candles(path):
    """1m candles. Candle CSVs are used as-is; 15s bot price polls are bucketed into 1m OHLC.
    Returns (bars, events) where events are (unix, event) from the candle CSV's event column."""
    bars, events = {}, []
    with open(path, newline="") as f:
        rows = csv.DictReader(f)
        poll = "tick_status" in (rows.fieldnames or [])
        for r in rows:
            if poll:
                if (r.get("tick_status") or "ACCEPTED") != "ACCEPTED":
                    continue
                t, p = ts(r.get("Timestamp")), fnum(r.get("Close"))
                if t is None or not p or p <= 0:
                    continue
                b = t // 60 * 60
                if b in bars:
                    o, h, l, _c, v = bars[b]
                    bars[b] = [o, max(h, p), min(l, p), p, v]
                else:
                    bars[b] = [p, p, p, p, 0.0]
            else:
                t = fnum(r.get("unix"))
                row = [fnum(r.get(k)) for k in ("open", "high", "low", "close")]
                if t is None or not all(x and x > 0 for x in row):
                    continue
                bars[int(t)] = row + [round(fnum(r.get("volume_usd")) or 0.0, 2)]
                for ev in filter(None, (r.get("event") or "").split("|")):
                    events.append((int(t), ev))
                mfe = fnum(r.get("min_from_entry"))
                if mfe is not None and not any(e == "_ENTRY_ROW" for _, e in events):
                    # The entry minute often has no candle; every row's offset gives the same entry time.
                    events.append((int(t - mfe * 60), "_ENTRY_ROW"))
    return sorted(bars.items()), events


def write_chart(name, bars, markers):
    t = [b[0] for b in bars]
    doc = {"t": t, "o": [sig(b[1][0]) for b in bars], "h": [sig(b[1][1]) for b in bars],
           "l": [sig(b[1][2]) for b in bars], "c": [sig(b[1][3]) for b in bars],
           "v": [b[1][4] for b in bars], "m": []}
    for at, kind, text in markers:
        if at is None:
            continue
        # Pin to the last bar at or before the event so it shows on every timeframe.
        pinned = max((x for x in t if x <= at), default=t[0])
        doc["m"].append([pinned, kind, text])
    (OUT / "t" / f"{name}.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    med = sorted(doc["c"])[len(doc["c"]) // 2]
    return 10 ** (math.floor(math.log10(med)) - 4)


def token_name(path, chain):
    # <chain>_<cmcid>_<SYM>.csv, <chain>_<SYM>_<unix>.csv, Done_<SYM>_<cmcid>.csv or <SYM>_<cmcid>.csv
    parts = path.stem.split("_")
    if parts[0] == "Done":
        parts = parts[1:]
    if parts[0] in CH:
        parts = parts[1:]
        sym = parts[1] if parts[0].isdigit() else parts[0]
    else:
        sym = parts[0]
    return f"{sym}-{CH.get(chain, chain.upper())}"


def stage2(rows):
    for r in rows:
        dec = f"DECISION {fnum(r['entry_to_snapshot_return_pct']):+.1f}% (dd {fnum(r['drawdown_from_seen_peak_pct']):.1f}%)"
        nxt = ("next60: recovered peak" if r["next60_recovered_seen_peak"] == "True" else "next60: no recovery") + \
              (", fell 10% more" if r["next60_further_10pct_close_decline"] == "True" else "")
        yield (r["relative_path"], r["chain"], r["group"],
               [(ts(r["entry_time_utc"]), "buy", "ENTRY"),
                (ts(r["decision_time_utc"]), "decision", dec),
                (ts(r["decision_time_utc"]) + 3600, "sim_exit", nxt)],
               f"{r['group']} | decision +{r['minutes_since_entry_at_decision']}m | {nxt}")


def stage3_2(rows):
    for r in rows:
        base, cand = fnum(r["baseline_roi_pct"]), fnum(r["candidate_roi_pct"])
        m = [(ts(r["baseline_entry_ts"]), "buy", "ENTRY")]
        if r["candidate_entry_ts"] and r["candidate_entry_ts"] != r["baseline_entry_ts"]:
            m.append((ts(r["candidate_entry_ts"]), "buy", "CAND ENTRY"))
        m.append((ts(r["candidate_base_fill_ts"] or r["candidate_signal_ts"]), "candidate",
                  f"CAND {r['strategy']}: {r['candidate_signal_reason']}{pct(cand)}"))
        m.append((ts(r["baseline_base_fill_ts"] or r["baseline_signal_ts"]), "sim_exit",
                  f"BASE {r['baseline_signal_reason']}{pct(base)}"))
        yield (r["source_file"], r["chain"], r["review_category"], m,
               f"{r['review_category']} | {r['strategy']} | base{pct(base)} -> cand{pct(cand)}"
               f" ({fnum(r['delta_pp']):+.1f}pp) | gate {r['momentum_proxy_gate']}")


def stage3_priority(rows):
    for r in rows:
        base, cand, rec = fnum(r["baseline_roi_pct"]), fnum(r["candidate_roi_pct"]), fnum(r["recorded_roi_pct"])
        m = [("entry", "buy", "ENTRY")]
        if fnum(r["baseline_hold_min"]) is not None:
            m.append(("+" + r["baseline_hold_min"], "sim_exit", f"BASE exit{pct(base)}"))
        if fnum(r["candidate_hold_min"]) is not None:
            m.append(("+" + r["candidate_hold_min"], "candidate", f"CAND {r['policy']}{pct(cand)}"))
        lab = f"{r['review_reason']} | {r['policy']} | base{pct(base)}"
        if cand is not None:
            lab += f" -> cand{pct(cand)} ({fnum(r['delta_pp']):+.1f}pp)"
        if rec is not None:
            lab += f" | recorded{pct(rec)}"
        if fnum(r["exit_time_discrepancy_minutes"]) is not None:
            lab += f" | exit-time off by {fnum(r['exit_time_discrepancy_minutes']):.0f}m"
        yield (r["file"], r["chain"], r["review_reason"], m, lab + f" | gate {r['momentum_proxy_gate']}")


REVIEWS = [
    ("stage2_dip10_chart_examples.csv", "Review: stage2 dip10", "s2", stage2),
    ("stage3_2_chart_review.csv", "Review: stage3.2", "s32", stage3_2),
    ("stage3_priority_chart_review.csv", "Review: stage3 priority", "s3p", stage3_priority),
]


def main():
    (OUT / "t").mkdir(parents=True, exist_ok=True)
    old = json.loads((OUT / "symbols.json").read_text())
    rest = [s for s in old if not s["category"].startswith("Review:")]
    used = {s["name"] for s in rest}
    new = []
    for fname, category, prefix, gen in REVIEWS:
        src = REVIEW_DIR / fname
        if not src.exists():
            print(f"skip {fname}: not found")
            continue
        n = 0
        for i, (ref, chain, group, markers, label) in enumerate(gen(list(csv.DictReader(open(src, newline=""))))):
            path = find(ref)
            if path is None:
                print(f"  {fname} row {i}: {ref} not found")
                continue
            bars, events = load_candles(path)
            if len(bars) < 30 and path.parent in POLL_DIRS:
                # A poll file with almost no ticks (e.g. a position the bot lost track of):
                # show the token's 1m candle chart instead.
                sym = token_name(path, chain).rsplit("-", 1)[0]
                alt = sorted(CHART_DIRS[1].glob(f"{chain}_{sym}_*.csv")) or sorted(CHART_DIRS[1].glob(f"*_{sym}_*.csv"))
                if alt:
                    bars, events = load_candles(alt[0])
                    label += f" | poll file had {len(load_candles(path)[0])} tick(s), showing 1m candles"
                    if sym in ONCHAIN_SELLS:
                        markers.append((ONCHAIN_SELLS[sym][0], "real", f"REAL SELL{pct(ONCHAIN_SELLS[sym][1])} (on-chain)"))
            if not bars:
                continue
            entry = next((t for t, e in events if e == "_ENTRY_ROW"), None)
            # stage3 priority gives exits as minutes after the chart's entry row
            markers = [((entry + int(float(at[1:])) * 60 if entry else None) if isinstance(at, str) and at.startswith("+")
                        else entry if at == "entry" else at, k, txt) for at, k, txt in markers]
            # real-trade charts: keep the real buy/sell so mismatches can be judged against them
            for t, e in events:
                if e == "REAL_BUY":
                    markers.append((t, "real", "REAL BUY"))
                elif e == "REAL_SELL":
                    markers.append((t, "real", "REAL SELL"))
            fid = f"{prefix}_{i}"
            tick = write_chart(fid, bars, markers)
            name, k = f"{token_name(path, chain)}-{prefix.upper()}-{i}", 2
            while name in used:
                name, k = f"{token_name(path, chain)}-{prefix.upper()}-{i}-{k}", k + 1
            used.add(name)
            new.append({"name": name, "file": fid, "category": category, "label": label, "tickSize": tick})
            n += 1
        print(f"{fname}: {n} charts -> {category}")
    (OUT / "symbols.json").write_text(json.dumps(new + rest, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(new)} review + {len(rest)} other symbols")


if __name__ == "__main__":
    main()
