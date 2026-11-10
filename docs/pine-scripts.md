# Pine scripts in OpenCharts

Eight supplied Pine Script® sources run inside the terminal as independently
toggled indicators/strategies, on any imported CSV dataset (for example the
historical ZEC/USDT chart). Execution is done by the third-party
[PineTS](https://github.com/LuxAlgo/PineTS) runtime; the chart layer only
consumes normalised JSON.

## How it fits together

| Layer | Files | Role |
| --- | --- | --- |
| Sources | `src/pine/scripts/*.pine` | The uploads, verbatim, plus two `.v5.pine` compatibility edits (originals kept next to them). |
| Registry | `src/pine/registry.ts` | One entry per script: label, pane (overlay / below), kind, support status, volume dependency, warm-up. |
| Data hygiene | `src/pine/data.ts` | Validation (finite/positive OHLC, high/low bounds, ascending unique times), gap counting, 1m→N aggregation, seconds↔ms round trip, price normalisation for tiny prices. |
| Runner | `src/pine/runner.ts` | Runs one script with PineTS and normalises plots, shapes, bgcolor/barcolor, labels, lines, tables, alerts and broker state into `PineRunResult` (times in unix seconds, aligned to candles or the run fails). |
| Independent backtester | `src/pine/backtest.ts` | A second implementation of the BuyTheDip fills with explicit assumptions; the runner compares both trade lists. |
| Engine | `src/pine/engine.ts`, `src/pine/pine.worker.ts`, `src/pine/cache-key.ts` | Web Worker execution (PineTS never enters the first-load bundle), result cache keyed by script + symbol + timeframe + volume mode + params + candle fingerprint. |
| Settings | `src/pine/params-store.ts`, `src/pages/trading/PineSettingsDialog.tsx` | Per-script parameter overrides read from the script's own `input.*` declarations, display toggles, per-symbol volume mode; persisted in localStorage. |
| Rendering | `src/pages/trading/usePineScripts.ts`, `usePineOverlays.ts`, `PinePanes.tsx`, `PineChartOverlays.tsx`, `chartMarkers.ts` | Evaluation hook; price-pane overlays (lines, `line.new` segments, bgcolor bands, barcolor painting); true lower panes (one lightweight-charts instance per oscillator, range/crosshair/axis-width synchronised); legend, meter tables, strategy ledger; the single marker composer. |

Script evaluation and rendering are separate: `usePineScripts` only knows
"which script, which window, which params → which result"; the overlay hook,
panes and marker composer consume results.

### Markers

`src/pages/trading/chartMarkers.ts` is the only place `setMarkers()` input is
assembled. It merges, in one time-sorted list with source-tagged ids:

- replay trade events (unchanged),
- adapter symbol markers (unchanged, `src/services/symbol-markers.ts`),
- imported CSV `ENTRY` / `partial_sell` / exit events (`useCsvEvents`, original event text kept),
- Pine `plotshape` hits (script's own text, e.g. `BUY`, `DIP`, `TOP`),
- Pine `label.new` texts (e.g. `Q: 65%`),
- strategy broker fills (`FILL Buy @price`, `FILL Stop +pnl`), only when the cross-check passed and the fill toggle is on.

A signal is never presented as a fill.

## Script status

| # | Script | Status | Pane | Notes |
| --- | --- | --- | --- | --- |
| 1 | Dip Buyer Manster 21 (RSI-14 + SMA100 of RSI) | **requires compatibility edit** | below | No `//@version`; PineTS only parses v5+. `dip-buyer-manster-21.v5.pine` keeps SMA(100) *of RSI(14)*, `transp=70` → `color.new(…, 70)`, `style=area` → `plot.style_area`. Verified against an independent RSI/SMA port (6 decimals). |
| 2 | Two Line Counter | supported unchanged | below | Loop is 1..21 (comment says 8; code wins). Verified against an independent port (exact). |
| 3 | HA Green:Red Ratio MAs | supported unchanged | below | Recursive HA open. Verified against an independent port (6 decimals); 200-MA is na for the first 200 bars. |
| 4 | Price vs Whale Money Flow | supported unchanged | below | Verified against an independent port (5 decimals). Volume is CSV quote volume; see below. |
| 5 | Dip Hunter [BackQuant] | supported unchanged | overlay | Triangles, bgcolor bands, bar colouring by score, meter table (rendered as HTML), EMA plots (off by default, as in the source), `line.new` entry lines (runtime keeps the last 50, like TradingView's default `max_lines_count`). |
| 6 | Top Finder & Dip Hunter [BackQuant] | supported unchanged | overlay | Support/resistance lines, DIP/TOP labels, `Q: n%` quality labels, bgcolor bands, selectable method. `ta.vwap` resets daily (UTC) in PineTS, matching TradingView's session anchor on 24/7 markets. |
| 7 | Decision Tree Buy Signal | supported unchanged | overlay | BUY markers from the seven source conditions only; VPT is computed by the script but not part of the signal and was not added. |
| 8 | BuyTheDip strategy | **requires compatibility edit** | overlay (strategy) | `//@version=4` → v5 (`ta.sma`, `ta.tr`, `ta.valuewhen`, `ta.lowest`), logic untouched. Fills come from the PineTS broker and are cross-checked trade-by-trade against `src/pine/backtest.ts`. |

Nothing is silently skipped: unsupported drawing kinds (boxes, polylines,
linefills) would surface as warnings in the legend; runtime warnings and
errors are shown per script.

### Strategy fill assumptions (BuyTheDip)

1. Script runs once per bar on the close; qty 1, no commission, no slippage.
2. `strategy.entry` fills at the next bar's open; pyramiding = 1.
3. `strategy.exit(stop, limit)` is live from the bar after it is placed; limit fills at the limit (or the open on a gap above), stop at the stop (or the open on a gap below).
4. Both levels in one bar: the extreme closer to the open trades first (TradingView broker-emulator rule).
5. ATR is `sma(tr, n)[1]`; while it is `na` the exit has `na` levels and does not exist.

On the ZEC history the runtime and the simulator agree trade-for-trade for
every window tested, with one documented deviation: PineTS evaluates `ta.tr`
on the **first bar of the window** as `high - low`, where TradingView's
`ta.tr` is `na`. The two only differ when the first entry happens inside the
ATR warm-up of the loaded window; the cross-check then fails loudly, the
ledger explains why, and no fill markers are drawn. An entry inside that
warm-up also has `na` exit levels in the Pine source itself, so the position
never closes; the legend reports "open position has no exit levels". Both
effects depend on where the loaded window starts — load more history.

Strategy results are a window-dependent backtest over the loaded bars, not
account trades, and are labelled as such in the ledger.

## Data invariants

- Candle times: CSV unix seconds → PineTS `openTime` ms → chart seconds; the
  round trip is asserted and every plotted time must match a loaded candle.
- Invalid OHLC, duplicated or unordered timestamps fail the run (stage
  `validate`). Missing minutes stay gaps; the legend shows the gap count. Pine
  lookbacks count bars, not wall-clock time.
- Indicators run on bars at the selected chart resolution (the adapter
  aggregates before the chart sees them; `aggregateCandles` in `data.ts` is
  the tested helper for adapters that need it). On the 1h ZEC file the "1m"
  timeframe shows the same hourly bars — that is adapter behaviour, and the
  gap counter reports it.
- Window: all loaded bars, capped at 10 000 most recent (`maxBars`). The
  first-paint window is 400 bars, deepened to several thousand a moment
  later, and scroll-loaded history recomputes over the whole window (results
  are cached per window fingerprint). Warm-up per script is in the registry;
  the About tab of each script shows the window actually used.
- Volume: the CSV `volume_usd` is **quote** volume. Scripts 4, 5 and 6 depend
  on volume; their legend shows `quote vol` and the Display tab offers an
  explicit "≈ base units (÷ OHLC4)" estimate. Datasets without any volume are
  refused for those scripts instead of fabricating signals from zeros.
- Tiny prices: PineTS rounds to 10 decimals, so prices below 1 are scaled by
  a power of ten before the run and price-domain outputs are divided back
  (all eight scripts are homogeneous in price — ratios, percentages or linear
  levels — so this is exact up to rounding). Tested with a 1e-9 price series.

## Using it

Indicators menu → **Pine scripts** section: each row toggles one script; the
gear (or the script's name in the chart legend / pane header) opens its
settings: Inputs (the script's own `input.*` list with defaults, ranges and
options), Display (bar painting, bgcolor bands, strategy fills and ledger,
volume mode), About (status, compatibility notes, last-run stats, warnings).
Oscillators get stacked lower panes synchronised with the price chart;
overlays draw on the candle price scale.

## Re-running on new CSV files

```bash
# 1. Convert CSVs (unix,open,high,low,close,volume_usd,event) into public/historical
python3 scripts/prepare_token_csvs.py /path/to/csvs            # 1-minute files
#    or, for the ZEC hourly download:
python3 scripts/download_zec_history.py --start 2019-03 --end 2026-11 --interval 1h --output /tmp/zec.csv
python3 scripts/prepare_token_csvs.py /tmp/dir-with-zec-csv

# 2. Verify every script against the data and fixtures
npm run typecheck && npm run test && npm run build

# 3. Standalone PineTS smoke test outside the app (optional)
#    see /root/pine-work/OpenCharts_PineTS_Workflow/README.md
```

`src/__tests__/pine-scripts.test.ts` runs all eight scripts on the last
1500 ZEC bars (skipped when `public/historical/CSV_ZECUSDT_…json` is absent)
and on synthetic fixtures (flat prices, high == low, zero volume, gaps,
tiny prices, warm-up, invalid input, `maxBars`), compares scripts 1–4 with
independent ports and the strategy with the independent simulator.

## Dependencies and licensing

- `pinets` **0.13.1** (pinned exact; transitive: acorn, acorn-walk, astring).
  PineTS is dual-licensed **AGPL-3.0 / commercial**. Shipping this build as a
  network service to users triggers AGPL's source-offer obligations for the
  combined work unless a commercial licence is obtained; keep deployments
  private or review before publishing. It is loaded only inside the Web
  Worker chunk (and a lazy main-thread fallback), so the first-load budget is
  unchanged (`npm run check:size`).
- The BackQuant, stonkmogger and racer8 sources are MPL-2.0 and keep their
  headers; the Manster 21 script carries no licence and is reproduced as
  supplied.
- lightweight-charts stays at 4.2 (no pane API); lower panes are separate
  synchronised chart instances.

## Known limits

- Pine `table` rendering covers cell text and colours (enough for the Dip
  Hunter meter); boxes/polylines/linefills are reported, not drawn.
- `plotshape` sizes and exact glyphs map onto lightweight-charts' four marker
  shapes (arrow up/down, circle, square).
- Alerts are collected (`alertcondition` with alert mode `all`) and counted
  but not surfaced as notifications.
- Pane time axes are hidden (the price chart's axis is shared); the crosshair
  is mirrored both ways.
- Symbol switching logs a lightweight-charts "Object is disposed" from a
  pending paint frame of the removed chart; it predates this work (it fires
  before any script is enabled) and is harmless.
