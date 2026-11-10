/**
 * The bundled Pine Script® sources and what the engine knows about each one.
 *
 * Sources are shipped verbatim (`*.pine`); where PineTS could not parse the
 * original (pre-v5 syntax) the file next to it with a `.v5.pine` suffix is the
 * smallest documented compatibility edit and the original stays for reference.
 * Authorship and licence headers are preserved inside each file.
 */
import type { PinePane, PineScriptKind } from "./types.ts";
import dipBuyerOriginal from "./scripts/dip-buyer-manster-21.original.pine?raw";
import dipBuyerV5 from "./scripts/dip-buyer-manster-21.v5.pine?raw";
import twoLineCounter from "./scripts/two-line-counter.pine?raw";
import haRatio from "./scripts/ha-green-red-ratio-ma.pine?raw";
import whaleMf from "./scripts/price-vs-whale-money-flow.pine?raw";
import dipHunter from "./scripts/dip-hunter-backquant.pine?raw";
import topFinder from "./scripts/top-finder-dip-hunter-backquant.pine?raw";
import decisionTree from "./scripts/decision-tree-buy-signal.pine?raw";
import buyTheDipOriginal from "./scripts/buy-the-dip-strategy.original.pine?raw";
import buyTheDipV5 from "./scripts/buy-the-dip-strategy.v5.pine?raw";

export type PineScriptId = `pine:${string}`;

export type PineSupportStatus = "supported unchanged" | "requires compatibility edit";

export interface PineScriptSpec {
  id: PineScriptId;
  label: string;
  shortLabel: string;
  author: string;
  license: string;
  /** Name of the file the script was supplied as. */
  fileName: string;
  /** What the engine executes. */
  source: string;
  /** The untouched upload, when `source` is a compatibility edit. */
  originalSource?: string;
  pane: PinePane;
  kind: PineScriptKind;
  status: PineSupportStatus;
  compatNotes?: string;
  /** Signals depend on `volume`; the engine refuses datasets without any. */
  usesVolume: boolean;
  /** Bars the longest lookback needs before every plot is non-na. */
  warmupBars: number;
  notes: string[];
  color: string;
}

export const PINE_SCRIPTS: PineScriptSpec[] = [
  {
    id: "pine:rsi-sma100",
    label: "RSI-14 + SMA100 of RSI (Dip Buyer Manster 21)",
    shortLabel: "RSI + RSI-SMA100",
    author: "u/dvdrummer360 (reddit)",
    license: "unspecified (as supplied)",
    fileName: "Dip Buyer Manster 21.txt",
    source: dipBuyerV5,
    originalSource: dipBuyerOriginal,
    pane: "below",
    kind: "indicator",
    status: "requires compatibility edit",
    compatNotes:
      "Original has no //@version directive (legacy syntax: study(), sma(), rsi(), transp=). PineTS only accepts v5+, so it runs a v5 conversion with identical maths: SMA(100) of RSI(14), never SMA of close.",
    usesVolume: false,
    warmupBars: 115,
    notes: ["RSI-SMA area is green when above 50, red otherwise.", "Reference lines at 30 / 50 / 70."],
    color: "#2962ff",
  },
  {
    id: "pine:two-line-counter",
    label: "Two Line Counter (Heikin Ashi Color County Lines)",
    shortLabel: "Two Line Counter",
    author: "stonkmogger",
    license: "MPL-2.0",
    fileName: "Heikin Ashi Color County Lines.txt",
    source: twoLineCounter,
    pane: "below",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: false,
    warmupBars: 22,
    notes: [
      "Loops i = 1..21 (the comment says 8; the code says 21 and the code is what runs).",
      "Compares (open[i]+close[i])/2 with (open[i-1]+high[i-1]+low[i-1]+close[i-1])/4; '<' counts blue, '>' counts red, equality counts neither.",
    ],
    color: "#2962ff",
  },
  {
    id: "pine:ha-ratio-ma",
    label: "Heikin Ashi Green:Red Ratio MAs",
    shortLabel: "HA Ratio MAs",
    author: "stonkmogger",
    license: "MPL-2.0",
    fileName: "Heikin Ashi Green Red Ratio MA.txt",
    source: haRatio,
    pane: "below",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: false,
    warmupBars: 210,
    notes: ["Recursive HA open; 8-bar green/red count; ratio = green when red is 0; SMA 10 / 50 / 200 of the ratio."],
    color: "#4caf50",
  },
  {
    id: "pine:whale-mf",
    label: "Price vs Whale Money Flow",
    shortLabel: "Whale MF",
    author: "stonkmogger",
    license: "MPL-2.0",
    fileName: "Price vs Whale Money Flow.txt",
    source: whaleMf,
    pane: "below",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: true,
    warmupBars: 30,
    notes: [
      "The CSV volume is quote (USD/USDT) volume, not base-token volume as on TradingView's ZECUSDT chart; results are volume-weighted and will differ.",
      "Nothing here measures actual whale activity; the name is the author's.",
    ],
    color: "#19cd8b",
  },
  {
    id: "pine:dip-hunter",
    label: "Dip Hunter [BackQuant]",
    shortLabel: "Dip Hunter",
    author: "BackQuant",
    license: "MPL-2.0",
    fileName: "DIp Hunter BackQuant.txt",
    source: dipHunter,
    pane: "overlay",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: true,
    warmupBars: 120,
    notes: [
      "Signal = 5-bar dip > 2% + volume spike (2x 65-bar avg) + volatility + close < EMA20 + EMA20 < EMA50 (+ optional EMA100 trend filter).",
      "Bar colouring by score, meter table, EMA lines (off by default) and entry lines are rendered from the runtime's drawing output.",
    ],
    color: "#00ff00",
  },
  {
    id: "pine:top-finder",
    label: "Top Finder & Dip Hunter [BackQuant]",
    shortLabel: "Top Finder",
    author: "BackQuant",
    license: "MPL-2.0",
    fileName: "Top Finder & Dip Hunter BackQuant.txt",
    source: topFinder,
    pane: "overlay",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: true,
    warmupBars: 210,
    notes: [
      "Support/resistance method is selectable (Dynamic / Fibonacci / Volatility / Volume Weighted / Hybrid).",
      "Volume Weighted and Hybrid use ta.vwap, which PineTS resets daily (UTC) like TradingView's session anchor.",
    ],
    color: "#ff0000",
  },
  {
    id: "pine:decision-tree",
    label: "Decision Tree Buy Signal",
    shortLabel: "Decision Tree",
    author: "stonkmogger",
    license: "MPL-2.0",
    fileName: "Decision Tree Buy Signal.txt",
    source: decisionTree,
    pane: "overlay",
    kind: "indicator",
    status: "supported unchanged",
    usesVolume: false,
    warmupBars: 130,
    notes: [
      "BUY = the seven thresholds in the source, exactly; the computed VPT series is not part of the signal and is not added.",
      "HA open here is nz(ha_close[1], close) — the author's approximation, kept as written.",
    ],
    color: "#4caf50",
  },
  {
    id: "pine:buy-the-dip",
    label: "BuyTheDip strategy (ATR take-profit / stop-loss)",
    shortLabel: "BuyTheDip",
    author: "racer8",
    license: "MPL-2.0",
    fileName: "Buying Dip Strategy With Take Profit and Stop Loss.txt",
    source: buyTheDipV5,
    originalSource: buyTheDipOriginal,
    pane: "overlay",
    kind: "strategy",
    status: "requires compatibility edit",
    compatNotes:
      "Original is //@version=4, which PineTS rejects. Converted to v5 (sma→ta.sma, tr→ta.tr, valuewhen→ta.valuewhen, lowest→ta.lowest); entry/exit logic and defaults untouched.",
    usesVolume: false,
    warmupBars: 12,
    notes: [
      "Enters long when close < lowest(low, 7)[1]; exits at avg price ± 2 × ATR(10) measured on the previous bar.",
      "Fills come from the PineTS broker emulator and are cross-checked against an independent simulator before any fill marker is drawn.",
    ],
    color: "#00bcd4",
  },
];

export const PINE_SCRIPT_IDS: PineScriptId[] = PINE_SCRIPTS.map((s) => s.id);

export function isPineScriptId(id: string): id is PineScriptId {
  return id.startsWith("pine:") && PINE_SCRIPTS.some((s) => s.id === id);
}

export function getPineScript(id: string): PineScriptSpec | undefined {
  return PINE_SCRIPTS.find((s) => s.id === id);
}
