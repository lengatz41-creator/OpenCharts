/**
 * Executes one bundled Pine script with PineTS and normalises the runtime's
 * context into `PineRunResult`. Pure with respect to the DOM — it runs in a
 * Web Worker in the browser and directly under vitest.
 *
 * PineTS (https://github.com/LuxAlgo/PineTS) is AGPL-3.0 / commercial
 * dual-licensed. It is pinned to 0.13.1, the version every bundled script was
 * tested against.
 */
import { Indicator, PineTS } from "pinets";
import type { Context } from "pinets";
import { BUY_THE_DIP_ASSUMPTIONS, BUY_THE_DIP_DEFAULTS, simulateBuyTheDip } from "./backtest.ts";
import { DEFAULT_MAX_BARS } from "./cache-key.ts";
import {
  CandleValidationError,
  countGaps,
  hasUsableVolume,
  priceScaleFactor,
  toKlines,
  validateCandles,
} from "./data.ts";
import { getPineScript, type PineScriptSpec } from "./registry.ts";
import type {
  PineBarColor,
  PineBgColor,
  PineDrawingLine,
  PineHLine,
  PineInputMeta,
  PineLabel,
  PineLinePlot,
  PineParamValue,
  PinePlotStyle,
  PinePoint,
  PineRunFailure,
  PineRunRequest,
  PineRunResult,
  PineShape,
  PineShapeKind,
  PineShapeLocation,
  PineStrategyResult,
  PineTable,
  PineTableCell,
  PineTrade,
} from "./types.ts";


const PINE_TIMEFRAMES: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

// ── Loose views over PineTS output (its public types are `any`) ──────────────

interface RawPoint {
  time: number;
  value: unknown;
  options?: { color?: unknown; [k: string]: unknown };
}
interface RawPlot {
  title?: string;
  data: RawPoint[];
  options?: Record<string, unknown>;
}
interface RawLabel {
  x: number;
  y: number;
  text: string;
  xloc: string;
  yloc: string;
  color: string;
  style: string;
  textcolor: string;
  _deleted?: boolean;
}
interface RawLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xloc: string;
  color: string;
  style: string;
  width: number;
  _deleted?: boolean;
}
interface RawCell {
  text: string;
  bgcolor?: string;
  text_color?: string;
}
interface RawTable {
  position: string;
  columns: number;
  rows: number;
  cells: RawCell[][];
  _deleted?: boolean;
}
interface RawTrade {
  id: string;
  entry_id: string;
  entry_price: number;
  entry_bar_index?: number;
  entry_time: number;
  size: number;
  exit_id?: string;
  exit_price?: number;
  exit_time?: number;
  profit?: number;
}
interface RawStrategy {
  closedtrades: RawTrade[];
  opentrades: RawTrade[];
  initial_capital: number;
  netprofit: number;
  grossprofit: number;
  grossloss: number;
  wintrades: number;
  losstrades: number;
  max_drawdown: number;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function isNa(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

function fail(scriptId: string, stage: PineRunFailure["stage"], error: string): PineRunFailure {
  return { ok: false, scriptId, stage, error };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function pineTimeframe(timeframe: string): string {
  return PINE_TIMEFRAMES[timeframe] ?? timeframe;
}

// ── Input metadata ───────────────────────────────────────────────────────────

export function describePineScript(scriptId: string): PineInputMeta[] {
  const spec = getPineScript(scriptId);
  if (!spec) throw new Error(`Unknown Pine script ${scriptId}`);
  const indicator = new Indicator(spec.source);
  return indicator.getInputsMeta().map((m) => ({
    key: m.varId ?? m.title ?? m.id,
    title: m.title ?? m.name,
    type: m.type,
    defval: asParamValue(m.defval),
    options: m.options?.map(asParamValue).filter((v): v is PineParamValue => v !== null),
    minval: m.minval,
    maxval: m.maxval,
    step: m.step,
    group: m.group,
    tooltip: m.tooltip,
  }));
}

function asParamValue(v: unknown): PineParamValue | null {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null;
}

// ── Execution ────────────────────────────────────────────────────────────────

export async function runPineScript(req: PineRunRequest): Promise<PineRunResult> {
  const spec = getPineScript(req.scriptId);
  if (!spec) return fail(req.scriptId, "unsupported", `Unknown Pine script ${req.scriptId}`);
  const maxBars = req.maxBars ?? DEFAULT_MAX_BARS;
  const candles = req.candles.length > maxBars ? req.candles.slice(-maxBars) : req.candles;
  if (candles.length === 0) return fail(spec.id, "validate", "No candles to run on");

  try {
    validateCandles(candles);
  } catch (err) {
    return fail(spec.id, "validate", err instanceof CandleValidationError ? err.message : errorMessage(err));
  }
  const hasVolume = hasUsableVolume(candles);
  if (spec.usesVolume && !hasVolume) {
    return fail(
      spec.id,
      "unsupported",
      "This dataset has no volume; the script's signals depend on volume and would be fabricated from zeros.",
    );
  }

  const scale = priceScaleFactor(candles);
  const klines = toKlines(candles, req.intervalSec, scale, req.volumeMode);
  const warnings: string[] = [];

  const indicator = new Indicator(spec.source);
  for (const [key, value] of Object.entries(req.params)) {
    try {
      if (!(key in indicator.input)) {
        warnings.push(`Ignored unknown input "${key}"`);
        continue;
      }
      indicator.input[key] = value;
    } catch (err) {
      warnings.push(`Could not set input "${key}": ${errorMessage(err)}`);
    }
  }
  try {
    indicator.prepare();
  } catch (err) {
    return fail(spec.id, "transpile", errorMessage(err));
  }

  const started = Date.now();
  let ctx: Context;
  try {
    const pine = new PineTS(klines, req.symbol, pineTimeframe(req.timeframe));
    pine.setAlertMode("all");
    ctx = await pine.run(indicator);
  } catch (err) {
    return fail(spec.id, "run", errorMessage(err));
  }
  const durationMs = Date.now() - started;

  try {
    return normalise(spec, req, candles, klines.map((k) => k.openTime), scale, hasVolume, durationMs, ctx, warnings);
  } catch (err) {
    return fail(spec.id, "normalise", errorMessage(err));
  }
}

// ── Normalisation ────────────────────────────────────────────────────────────

function normalise(
  spec: PineScriptSpec,
  req: PineRunRequest,
  candles: PineRunRequest["candles"],
  openTimesMs: number[],
  scale: number,
  hasVolume: boolean,
  durationMs: number,
  ctx: Context,
  warnings: string[],
): PineRunResult {
  const secByMs = new Map<number, number>();
  openTimesMs.forEach((ms, i) => secByMs.set(ms, candles[i]!.time));
  const timeOf = (ms: unknown, what: string): number => {
    const sec = typeof ms === "number" ? secByMs.get(ms) : undefined;
    if (sec === undefined) throw new Error(`${what}: time ${String(ms)} is not aligned with a loaded candle`);
    return sec;
  };
  const barTime = (index: unknown, what: string): number => {
    if (typeof index !== "number" || !Number.isFinite(index)) throw new Error(`${what}: bad bar index ${String(index)}`);
    const i = Math.min(candles.length - 1, Math.max(0, Math.round(index)));
    return candles[i]!.time;
  };
  const unscale = (v: number | null): number | null => (v === null ? null : v / scale);

  const lines: PineLinePlot[] = [];
  const hlines: PineHLine[] = [];
  const shapes: PineShape[] = [];
  const bgcolors: PineBgColor[] = [];
  const barcolors: PineBarColor[] = [];
  let labels: PineLabel[] = [];
  let drawingLines: PineDrawingLine[] = [];
  let tables: PineTable[] = [];

  const plots = (ctx.plots ?? {}) as Record<string, RawPlot>;
  for (const [key, plot] of Object.entries(plots)) {
    const options = plot.options ?? {};
    const style = str(options.style);
    const first = plot.data?.[0];
    if (key === "__labels__") {
      labels = normaliseLabels((first?.value as RawLabel[]) ?? [], barTime, timeOf, unscale);
      continue;
    }
    if (key === "__lines__") {
      drawingLines = normaliseLines((first?.value as RawLine[]) ?? [], barTime, timeOf, unscale);
      continue;
    }
    if (key === "__tables__") {
      tables = normaliseTables((first?.value as RawTable[]) ?? []);
      continue;
    }
    if (key.startsWith("__")) {
      const count = Array.isArray(first?.value) ? (first.value as unknown[]).filter((d) => !(d as { _deleted?: boolean })._deleted).length : 0;
      if (count > 0) warnings.push(`${count} ${key.replaceAll("_", "")} object(s) are not rendered`);
      continue;
    }
    const title = plot.title ?? str(options.title, key);
    if (style === "hline") {
      const point = plot.data.find((p) => num(p.value) !== null);
      const value = point ? num(point.value) : null;
      if (value !== null) {
        hlines.push({
          title,
          value,
          color: str(options.color, "#787b86"),
          style: str(options.linestyle) === "dashed" ? "dashed" : str(options.linestyle) === "dotted" ? "dotted" : "solid",
        });
      }
      continue;
    }
    if (style === "shape" || style === "char") {
      const shape = normaliseShapeKind(str(options.shape), style);
      const location = normaliseLocation(str(options.location));
      for (const p of plot.data) {
        if (p.value !== true) continue;
        shapes.push({
          time: timeOf(p.time, title),
          title,
          shape,
          location,
          color: str(p.options?.color, str(options.color, "#2196f3")),
          text: str(options.text) || undefined,
          textColor: str(options.textcolor) || undefined,
        });
      }
      continue;
    }
    if (style === "background") {
      for (const p of plot.data) {
        const color = str(p.options?.color);
        if (!color || isNa(p.value) || p.value === false) continue;
        bgcolors.push({ time: timeOf(p.time, title), color });
      }
      continue;
    }
    if (style === "barcolor") {
      for (const p of plot.data) {
        const color = str(p.options?.color);
        if (!color || isNa(p.value) || p.value === false) continue;
        barcolors.push({ time: timeOf(p.time, title), color });
      }
      continue;
    }
    // Numeric series
    // PineTS does not propagate `overlay=true` from a strategy() declaration,
    // so trust the registry: every numeric plot of an overlay script is a price.
    const overlay = Boolean(options.overlay) || Boolean(options.force_overlay) || spec.pane === "overlay";
    const baseColor = str(options.color, "#2196f3");
    const points: PinePoint[] = plot.data.map((p) => {
      const raw = num(p.value);
      const value = overlay ? unscale(raw) : raw;
      const color = str(p.options?.color);
      const point: PinePoint = { time: timeOf(p.time, title), value };
      if (color && color !== baseColor) point.color = color;
      return point;
    });
    lines.push({
      title,
      color: baseColor,
      lineWidth: num(options.linewidth) ?? 1,
      style: normalisePlotStyle(style),
      overlay,
      points,
    });
  }

  const alerts = ((ctx.alerts ?? []) as { time: number; title?: string; message: string }[]).map((a) => ({
    time: timeOf(a.time, "alert"),
    title: a.title ?? "",
    message: a.message,
  }));
  for (const w of (ctx.warnings ?? []) as { message: string; bar: number }[]) {
    const text = `bar ${w.bar}: ${w.message}`;
    if (!warnings.includes(text)) warnings.push(text);
    if (warnings.length >= 20) break;
  }

  let strategy: PineStrategyResult | undefined;
  if (spec.kind === "strategy") {
    const raw = ctx.strategy as unknown as RawStrategy | undefined;
    if (!raw) throw new Error("strategy script produced no broker state");
    strategy = normaliseStrategy(spec, req, candles, raw, timeOf, scale);
  }

  const gaps = countGaps(candles, req.intervalSec);
  return {
    ok: true,
    scriptId: spec.id,
    meta: {
      scriptId: spec.id,
      symbol: req.symbol,
      timeframe: req.timeframe,
      bars: candles.length,
      firstTime: candles[0]!.time,
      lastTime: candles[candles.length - 1]!.time,
      priceScale: scale,
      durationMs,
      gaps: gaps.gaps,
      missingBars: gaps.missingBars,
      volumeMode: req.volumeMode,
      hasVolume,
      pineVersion: ctx.pineVersion ?? null,
      warmupBars: spec.warmupBars,
    },
    lines,
    hlines,
    shapes,
    bgcolors,
    barcolors,
    labels,
    drawingLines,
    tables,
    alerts,
    warnings,
    strategy,
  };
}

function normalisePlotStyle(style: string): PinePlotStyle {
  switch (style) {
    case "style_area":
      return "area";
    case "style_histogram":
      return "histogram";
    case "style_columns":
      return "columns";
    case "style_cross":
      return "cross";
    case "style_circles":
      return "circles";
    case "style_stepline":
    case "style_stepline_diamond":
      return "stepline";
    case "style_linebr":
      return "linebr";
    default:
      return "line";
  }
}

function normaliseShapeKind(shape: string, style: string): PineShapeKind {
  if (style === "char") return "circle";
  const s = shape.replace(/^shape_/, "");
  switch (s) {
    case "triangle_up":
    case "triangleup":
      return "triangleup";
    case "triangle_down":
    case "triangledown":
      return "triangledown";
    case "label_up":
    case "labelup":
      return "labelup";
    case "label_down":
    case "labeldown":
      return "labeldown";
    case "arrow_up":
    case "arrowup":
      return "arrowup";
    case "arrow_down":
    case "arrowdown":
      return "arrowdown";
    case "square":
      return "square";
    case "cross":
      return "cross";
    case "xcross":
      return "xcross";
    case "diamond":
      return "diamond";
    case "flag":
      return "flag";
    default:
      return "circle";
  }
}

function normaliseLocation(location: string): PineShapeLocation {
  switch (location.toLowerCase()) {
    case "abovebar":
      return "abovebar";
    case "belowbar":
      return "belowbar";
    case "top":
      return "top";
    case "bottom":
      return "bottom";
    default:
      return "absolute";
  }
}

function lineStyle(style: string): "solid" | "dashed" | "dotted" {
  if (style.includes("dash")) return "dashed";
  if (style.includes("dot")) return "dotted";
  return "solid";
}

function normaliseLabels(
  raw: RawLabel[],
  barTime: (i: unknown, what: string) => number,
  timeOf: (ms: unknown, what: string) => number,
  unscale: (v: number | null) => number | null,
): PineLabel[] {
  const out: PineLabel[] = [];
  for (const l of raw) {
    if (l._deleted) continue;
    const time = l.xloc === "bt" ? timeOf(l.x, "label") : barTime(l.x, "label");
    out.push({
      time,
      price: l.yloc === "pr" ? unscale(num(l.y)) : null,
      text: str(l.text),
      color: str(l.color, "#2196f3"),
      textColor: str(l.textcolor, "#ffffff"),
      style: l.style.includes("up") ? "up" : l.style.includes("down") ? "down" : "other",
    });
  }
  return out;
}

function normaliseLines(
  raw: RawLine[],
  barTime: (i: unknown, what: string) => number,
  timeOf: (ms: unknown, what: string) => number,
  unscale: (v: number | null) => number | null,
): PineDrawingLine[] {
  const out: PineDrawingLine[] = [];
  for (const l of raw) {
    if (l._deleted) continue;
    const y1 = unscale(num(l.y1));
    const y2 = unscale(num(l.y2));
    if (y1 === null || y2 === null) continue;
    const t1 = l.xloc === "bt" ? timeOf(l.x1, "line") : barTime(l.x1, "line");
    const t2 = l.xloc === "bt" ? timeOf(l.x2, "line") : barTime(l.x2, "line");
    out.push({
      fromTime: Math.min(t1, t2),
      toTime: Math.max(t1, t2),
      fromPrice: t1 <= t2 ? y1 : y2,
      toPrice: t1 <= t2 ? y2 : y1,
      color: str(l.color, "#2196f3"),
      width: num(l.width) ?? 1,
      style: lineStyle(str(l.style)),
    });
  }
  return out;
}

function normaliseTables(raw: RawTable[]): PineTable[] {
  const out: PineTable[] = [];
  for (const t of raw) {
    if (t._deleted) continue;
    const cells = Array.isArray(t.cells) ? t.cells : [];
    // PineTS stores cells[column][row]; present rows[row][column] to the UI.
    const columnMajor = cells.length === t.columns && cells.length !== t.rows;
    const rows: PineTableCell[][] = [];
    for (let r = 0; r < t.rows; r++) {
      const row: PineTableCell[] = [];
      for (let c = 0; c < t.columns; c++) {
        const cell = columnMajor ? cells[c]?.[r] : cells[r]?.[c];
        row.push({
          text: str(cell?.text),
          bgColor: cell?.bgcolor ? str(cell.bgcolor) : null,
          textColor: cell?.text_color ? str(cell.text_color) : null,
        });
      }
      rows.push(row);
    }
    out.push({ position: str(t.position, "bottom_center"), rows });
  }
  return out;
}

function toTrade(t: RawTrade, timeOf: (ms: unknown, what: string) => number, scale: number): PineTrade {
  return {
    id: t.id,
    entryId: t.entry_id,
    entryTime: timeOf(t.entry_time, "trade entry"),
    entryPrice: t.entry_price / scale,
    size: t.size,
    exitId: t.exit_id ?? null,
    exitTime: t.exit_time === undefined ? null : timeOf(t.exit_time, "trade exit"),
    exitPrice: t.exit_price === undefined ? null : t.exit_price / scale,
    profit: t.profit === undefined ? null : t.profit / scale,
  };
}

function normaliseStrategy(
  spec: PineScriptSpec,
  req: PineRunRequest,
  candles: PineRunRequest["candles"],
  raw: RawStrategy,
  timeOf: (ms: unknown, what: string) => number,
  scale: number,
): PineStrategyResult {
  const trades = raw.closedtrades.map((t) => toTrade(t, timeOf, scale));
  const openTrade = raw.opentrades[0] ? toTrade(raw.opentrades[0], timeOf, scale) : null;

  const mismatches: string[] = [];
  let simulatorTrades = 0;
  let openTradeStuck = false;
  if (spec.id === "pine:buy-the-dip") {
    const p = req.params;
    const sim = simulateBuyTheDip(candles, {
      atrLength: typeof p.atn === "number" ? p.atn : BUY_THE_DIP_DEFAULTS.atrLength,
      takeProfitMult: typeof p.tpm === "number" ? p.tpm : BUY_THE_DIP_DEFAULTS.takeProfitMult,
      stopLossMult: typeof p.slm === "number" ? p.slm : BUY_THE_DIP_DEFAULTS.stopLossMult,
      dipLength: typeof p.n === "number" ? p.n : BUY_THE_DIP_DEFAULTS.dipLength,
    });
    simulatorTrades = sim.trades.length;
    const tol = (a: number) => 1e-7 * Math.max(1, Math.abs(a));
    const count = Math.max(sim.trades.length, trades.length);
    for (let i = 0; i < count && mismatches.length < 8; i++) {
      const a = trades[i];
      const b = sim.trades[i];
      if (!a || !b) {
        mismatches.push(`trade ${i + 1}: ${a ? "only the runtime" : "only the simulator"} produced it`);
        continue;
      }
      const diffs: string[] = [];
      if (a.entryTime !== b.entryTime) diffs.push(`entry time ${a.entryTime} vs ${b.entryTime}`);
      if (Math.abs(a.entryPrice - b.entryPrice) > tol(a.entryPrice)) diffs.push(`entry ${a.entryPrice} vs ${b.entryPrice}`);
      if (a.exitTime !== b.exitTime) diffs.push(`exit time ${a.exitTime} vs ${b.exitTime}`);
      if (a.exitPrice !== null && b.exitPrice !== null && Math.abs(a.exitPrice - b.exitPrice) > tol(a.exitPrice)) {
        diffs.push(`exit ${a.exitPrice} vs ${b.exitPrice}`);
      }
      if (diffs.length) mismatches.push(`trade ${i + 1}: ${diffs.join(", ")}`);
    }
    const openA = openTrade?.entryTime ?? null;
    const openB = sim.open?.entryTime ?? null;
    if (openA !== openB) mismatches.push(`open trade: runtime ${openA ?? "none"} vs simulator ${openB ?? "none"}`);
    openTradeStuck = sim.open !== null && !(Number.isFinite(sim.open.takeProfit) && Number.isFinite(sim.open.stopLoss));
    // Known runtime deviation: PineTS evaluates `ta.tr` on the window's first
    // bar as high-low where TradingView returns na, so its ATR exists one bar
    // earlier. Only an entry inside that warm-up can tell the difference.
    const atrLength = typeof p.atn === "number" ? p.atn : BUY_THE_DIP_DEFAULTS.atrLength;
    const firstRuntimeEntryBar = raw.closedtrades[0]?.entry_bar_index ?? raw.opentrades[0]?.entry_bar_index;
    if (mismatches.length > 0 && firstRuntimeEntryBar !== undefined && firstRuntimeEntryBar <= atrLength + 1) {
      mismatches.unshift(
        `first entry falls inside the ATR(${atrLength}) warm-up of the loaded window, where PineTS's ta.tr (high-low on bar 0) differs from TradingView's (na); load more history so the window starts earlier`,
      );
    }
  } else {
    mismatches.push("no independent simulator for this strategy");
  }

  return {
    trades,
    openTrade,
    openTradeStuck,
    initialCapital: raw.initial_capital,
    netProfit: raw.netprofit / scale,
    grossProfit: raw.grossprofit / scale,
    grossLoss: raw.grossloss / scale,
    winTrades: raw.wintrades,
    lossTrades: raw.losstrades,
    maxDrawdown: raw.max_drawdown / scale,
    assumptions: BUY_THE_DIP_ASSUMPTIONS,
    crossCheck: {
      passed: mismatches.length === 0,
      simulatorTrades,
      runtimeTrades: trades.length,
      mismatches,
    },
  };
}
