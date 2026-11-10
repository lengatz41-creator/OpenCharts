#!/usr/bin/env python3
"""Convert /root/CMC_TOKEN_CHARTS CSVs into the static JSON the CMC adapter loads.

Output (default /root/OpenCharts/cmc-data):
  symbols.json        one entry per token: name, file, category, label, tickSize
  t/<file>.json       {"t":[unix s], "o","h","l","c","v":[...], "m":[[unix s, kind, text], ...]}
Re-run after the source CSVs change, then `npm run build:cmc`."""
import csv, json, math, sys
from pathlib import Path

SRC = Path("/root/CMC_TOKEN_CHARTS")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/root/OpenCharts/cmc-data")
CH = {"bsc": "BSC", "ethereum": "ETH", "eth": "ETH", "solana": "SOL"}
EXITS = {"runner_floor", "runner_trail", "horizon_48h", "stop_loss"}
# Sells the bot's ledger never recorded, traced on-chain (sell unix, ROI % in SOL/BNB).
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


def convert(csv_path, out_name, marker_text, extra=None):
    t, o, h, l, c, v, m = [], [], [], [], [], [], []
    with open(csv_path, newline="") as f:
        for r in csv.DictReader(f):
            try:
                ts = int(r["unix"])
                row = [float(r[k]) for k in ("open", "high", "low", "close")]
            except (TypeError, ValueError):
                continue
            if not all(math.isfinite(x) and x > 0 for x in row):
                continue
            t.append(ts); o.append(sig(row[0])); h.append(sig(row[1])); l.append(sig(row[2])); c.append(sig(row[3]))
            v.append(round(fnum(r.get("volume_usd")) or 0.0, 2))
            for ev in filter(None, (r.get("event") or "").split("|")):
                kind, text = marker_text(ev)
                if kind:
                    m.append([ts, kind, text])
    if not t:
        return None
    if extra:
        # Pin to the last bar at or before the event so it shows on every timeframe.
        ts, kind, text = extra
        at = max((x for x in t if x <= ts), default=t[0])
        if ts > t[-1] + 60:
            text += f" ({(ts - t[-1]) / 3600:.0f}h after chart end)"
        m.append([at, kind, text])
    (OUT / "t" / f"{out_name}.json").write_text(json.dumps(
        {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v, "m": m}, separators=(",", ":"), ensure_ascii=False))
    med = sorted(c)[len(c) // 2]
    return 10 ** (math.floor(math.log10(med)) - 4)


def main():
    (OUT / "t").mkdir(parents=True, exist_ok=True)
    syms, used = [], set()

    def uniq(name):
        base, i = name, 2
        while name in used:
            name, i = f"{base}-{i}", i + 1
        used.add(name)
        return name

    # Real trades first
    for r in csv.DictReader(open(SRC / "real_trades/index.csv", newline="")):
        real, sim = fnum(r.get("real_roi_pct")), fnum(r.get("sim_partial75_roi_pct"))
        flag = (r.get("ledger_flag") or "").strip()

        def mt(ev, real=real, sim=sim):
            if ev == "REAL_BUY": return "buy", "REAL BUY"
            if ev == "REAL_SELL": return "sell_final", "REAL SELL" + pct(real)
            if ev == "SIM_partial_sell": return "sim_partial", "sim 75%"
            if ev.startswith("SIM_"): return "sim_exit", "sim exit" + pct(sim)
            return None, None
        extra = None
        if not r.get("sell_utc") and r.get("symbol") in ONCHAIN_SELLS:
            sell_ts, real = ONCHAIN_SELLS[r["symbol"]]
            extra = (sell_ts, "sell_final", "REAL SELL" + pct(real) + " on-chain, not in ledger")
        fname = f"r{r['k']}"
        tick = convert(SRC / "real_trades" / r["file"], fname, mt, extra)
        if tick is None:
            continue
        sym = (r.get("symbol") or "?").replace(" ", "_")
        ch = CH.get(r["chain"], r["chain"].upper())
        syms.append({"name": uniq(f"{sym}-{ch}-REAL"), "file": fname, "category": "Real trades",
                     "label": f"{r.get('name') or sym} | bought {r.get('buy_utc','')[:16]} | real{pct(real) or ' n/a'}"
                              f" | sim{pct(sim) or ' n/a'}" + (" | " + r["note"][:80] if r.get("note") else ""),
                     "tickSize": tick, "sort": r.get("buy_unix") or "0"})

    # Backtest tokens, newest first
    rows = list(csv.DictReader(open(SRC / "index.csv", newline="")))
    rows.sort(key=lambda r: -int(fnum(r.get("entry_unix")) or 0))
    for i, r in enumerate(rows):
        roi = fnum(r.get("roi_partial75"))
        roi = None if roi is None else roi * 100

        def mt(ev, roi=roi):
            if ev == "ENTRY": return "buy", "BUY"
            if ev == "partial_sell": return "partial", "SELL 75%"
            if ev in EXITS: return "sell_final", f"EXIT {ev}" + pct(roi)
            return None, None
        fname = f"b{r['chain'][:1]}{r['cmc_id']}"
        tick = convert(SRC / r["file"], fname, mt)
        if tick is None:
            continue
        sym = (r.get("symbol") or "?").replace(" ", "_")
        ch = CH.get(r["chain"], r["chain"].upper())
        dep = (r.get("in_deploy_universe") or "") == "True"
        syms.append({"name": uniq(f"{sym}-{ch}-{r['cmc_id']}"), "file": fname,
                     "category": f"Backtest {ch}",
                     "label": f"listed {r.get('listing_utc','')[:16]} | sim{pct(roi) or ' n/a'}"
                              f" | {'passes go-live filters' if dep else 'filtered out by go-live rules'}",
                     "tickSize": tick, "sort": r.get("entry_unix") or "0"})
        if i % 500 == 0:
            print(f"{i}/{len(rows)}", flush=True)
    for s in syms:
        s.pop("sort", None)
    # Keep review lists added by build-review-data.py
    prev = OUT / "symbols.json"
    if prev.exists():
        syms = [s for s in json.loads(prev.read_text()) if s["category"].startswith("Review:")] + syms
    (OUT / "symbols.json").write_text(json.dumps(syms, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(syms)} symbols -> {OUT}")


if __name__ == "__main__":
    main()
