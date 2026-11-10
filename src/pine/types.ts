/**
 * Normalised output of a Pine script run.
 *
 * The PineTS runtime hands back a loosely typed `Context`; `runner.ts` turns it
 * into these plain, JSON-serialisable shapes so the chart layer (and the Web
 * Worker boundary) never sees PineTS internals. Every `time` is **unix
 * seconds**, aligned to a candle the script was given.
 */

export type PinePane = "overlay" | "below";
export type PineScriptKind = "indicator" | "strategy";
export type PineVolumeMode = "quote" | "approx-base";

/** One bar handed to the engine. `time` is unix seconds; `volume` is as-is. */
export interface PineCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PineParamValue = number | string | boolean;
export type PineParams = Record<string, PineParamValue>;

export interface PineInputMeta {
  /** Stable key used for overrides (`varId` when available, else the title). */
  key: string;
  title: string;
  type: string;
  defval: PineParamValue | null;
  options?: PineParamValue[];
  minval?: number;
  maxval?: number;
  step?: number;
  group?: string;
  tooltip?: string;
}

export type PinePlotStyle =
  | "line"
  | "area"
  | "histogram"
  | "columns"
  | "cross"
  | "circles"
  | "stepline"
  | "linebr";

export interface PinePoint {
  time: number;
  /** `null` is Pine `na` — the point is drawn as a gap. */
  value: number | null;
  /** Per-bar colour when the script colours the series conditionally. */
  color?: string;
}

export interface PineLinePlot {
  title: string;
  color: string;
  lineWidth: number;
  style: PinePlotStyle;
  /** True when the series belongs on the price scale (overlay / force_overlay). */
  overlay: boolean;
  points: PinePoint[];
}

export interface PineHLine {
  title: string;
  value: number;
  color: string;
  style: "solid" | "dashed" | "dotted";
}

export type PineShapeKind =
  | "triangleup"
  | "triangledown"
  | "labelup"
  | "labeldown"
  | "arrowup"
  | "arrowdown"
  | "circle"
  | "square"
  | "cross"
  | "xcross"
  | "diamond"
  | "flag";

export type PineShapeLocation = "abovebar" | "belowbar" | "absolute" | "top" | "bottom";

/** A `plotshape` / `plotchar` hit on one bar. */
export interface PineShape {
  time: number;
  title: string;
  shape: PineShapeKind;
  location: PineShapeLocation;
  color: string;
  text?: string;
  textColor?: string;
}

export interface PineBarColor {
  time: number;
  color: string;
}

export interface PineBgColor {
  time: number;
  color: string;
}

/** A `label.new` object (bar-index anchored; `price` is the y). */
export interface PineLabel {
  time: number;
  price: number | null;
  text: string;
  color: string;
  textColor: string;
  style: "up" | "down" | "other";
}

/** A `line.new` object between two bars. Times are clamped to loaded bars. */
export interface PineDrawingLine {
  fromTime: number;
  toTime: number;
  fromPrice: number;
  toPrice: number;
  color: string;
  width: number;
  style: "solid" | "dashed" | "dotted";
}

export interface PineTableCell {
  text: string;
  bgColor: string | null;
  textColor: string | null;
}

export interface PineTable {
  position: string;
  /** rows[rowIndex][columnIndex] */
  rows: PineTableCell[][];
}

export interface PineAlert {
  time: number;
  title: string;
  message: string;
}

export interface PineTrade {
  id: string;
  entryId: string;
  entryTime: number;
  entryPrice: number;
  size: number;
  exitId: string | null;
  exitTime: number | null;
  exitPrice: number | null;
  profit: number | null;
}

export interface PineStrategyCrossCheck {
  passed: boolean;
  simulatorTrades: number;
  runtimeTrades: number;
  mismatches: string[];
}

export interface PineStrategyResult {
  trades: PineTrade[];
  openTrade: PineTrade | null;
  /**
   * The open position has no exit levels (its ATR was `na` at entry, so the
   * script placed an exit with `na` stop/limit) and can never close. Depends
   * on where the history window starts.
   */
  openTradeStuck: boolean;
  initialCapital: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  winTrades: number;
  lossTrades: number;
  maxDrawdown: number;
  /** The fill model the numbers were produced under, for the ledger UI. */
  assumptions: string[];
  /** Independent fill simulation compared against the runtime broker. */
  crossCheck: PineStrategyCrossCheck;
}

export interface PineRunMeta {
  scriptId: string;
  symbol: string;
  timeframe: string;
  bars: number;
  firstTime: number;
  lastTime: number;
  /** Prices were multiplied by this before the run and divided after. */
  priceScale: number;
  durationMs: number;
  /** Bars whose predecessor is more than one interval earlier. */
  gaps: number;
  /** Interval slots missing inside those gaps. */
  missingBars: number;
  volumeMode: PineVolumeMode;
  hasVolume: boolean;
  pineVersion: number | null;
  warmupBars: number;
}

export interface PineRunSuccess {
  ok: true;
  scriptId: string;
  meta: PineRunMeta;
  lines: PineLinePlot[];
  hlines: PineHLine[];
  shapes: PineShape[];
  bgcolors: PineBgColor[];
  barcolors: PineBarColor[];
  labels: PineLabel[];
  drawingLines: PineDrawingLine[];
  tables: PineTable[];
  alerts: PineAlert[];
  warnings: string[];
  strategy?: PineStrategyResult;
}

export interface PineRunFailure {
  ok: false;
  scriptId: string;
  error: string;
  stage: "validate" | "unsupported" | "transpile" | "run" | "normalise";
}

export type PineRunResult = PineRunSuccess | PineRunFailure;

export interface PineRunRequest {
  scriptId: string;
  symbol: string;
  /** OpenCharts timeframe label ("1m", "1h", ...). */
  timeframe: string;
  intervalSec: number;
  candles: PineCandle[];
  params: PineParams;
  volumeMode: PineVolumeMode;
  /** Compute on at most this many of the most recent bars. */
  maxBars?: number;
}
