/**
 * Candle hygiene for the Pine engine: validation, gap accounting, timeframe
 * aggregation, seconds <-> milliseconds conversion and price normalisation.
 * Pure functions, no chart or runtime imports, so they are unit-testable and
 * usable from the worker.
 */
import type { PineCandle, PineVolumeMode } from "./types.ts";

export class CandleValidationError extends Error {
  constructor(
    message: string,
    public readonly index: number,
  ) {
    super(`candle[${index}]: ${message}`);
    this.name = "CandleValidationError";
  }
}

/**
 * Throw when the series cannot be fed to a Pine script: non-finite or
 * non-positive prices, high/low that do not bound open/close, non-ascending
 * or duplicated timestamps, negative volume, non-integer seconds.
 */
export function validateCandles(candles: PineCandle[]): void {
  let prev = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const { time, open, high, low, close, volume } = c;
    if (!Number.isInteger(time) || time <= 0) throw new CandleValidationError("time must be positive integer unix seconds", i);
    if (time <= prev) throw new CandleValidationError(time === prev ? "duplicate timestamp" : "timestamps not ascending", i);
    for (const [k, v] of [["open", open], ["high", high], ["low", low], ["close", close]] as const) {
      if (!Number.isFinite(v) || v <= 0) throw new CandleValidationError(`${k} must be finite and positive`, i);
    }
    if (!Number.isFinite(volume) || volume < 0) throw new CandleValidationError("volume must be finite and non-negative", i);
    if (low > high) throw new CandleValidationError("low above high", i);
    if (low > Math.min(open, close) || high < Math.max(open, close)) {
      throw new CandleValidationError("open/close outside high/low", i);
    }
    prev = time;
  }
}

/** Count interval gaps (no synthetic bars are ever inserted). */
export function countGaps(candles: PineCandle[], intervalSec: number): { gaps: number; missingBars: number } {
  let gaps = 0;
  let missingBars = 0;
  if (intervalSec <= 0) return { gaps, missingBars };
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.time - candles[i - 1]!.time;
    if (delta > intervalSec) {
      gaps += 1;
      missingBars += Math.round(delta / intervalSec) - 1;
    }
  }
  return { gaps, missingBars };
}

export function hasUsableVolume(candles: PineCandle[]): boolean {
  return candles.some((c) => Number.isFinite(c.volume) && c.volume > 0);
}

/** Seconds -> milliseconds for PineTS `openTime`, asserting the round trip. */
export function secToMs(sec: number): number {
  const ms = sec * 1000;
  if (!Number.isSafeInteger(ms) || msToSec(ms) !== sec) throw new Error(`time ${sec} does not round-trip through milliseconds`);
  return ms;
}

/** Milliseconds (PineTS plot times) -> integer unix seconds, or null if unaligned. */
export function msToSec(ms: number): number {
  const sec = ms / 1000;
  if (!Number.isInteger(sec)) throw new Error(`time ${ms}ms is not a whole second`);
  return sec;
}

/**
 * Power-of-ten factor that lifts sub-unit prices into a range where PineTS's
 * ten-decimal rounding keeps at least nine significant digits. Prices at or
 * above 1 are left alone (factor 1). Every bundled script is homogeneous in
 * price (ratios, percentages, or linear price levels), so scaling the input
 * and dividing price-domain outputs back is exact up to rounding.
 */
export function priceScaleFactor(candles: PineCandle[]): number {
  if (candles.length === 0) return 1;
  const closes = candles.map((c) => c.close).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)]!;
  if (!(median > 0) || median >= 1) return 1;
  const k = Math.ceil(2 - Math.log10(median));
  return 10 ** Math.min(k, 18);
}

export interface PineKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Build the OHLCV array PineTS expects (`openTime` in ms), scaled and in volume mode. */
export function toKlines(
  candles: PineCandle[],
  intervalSec: number,
  scale: number,
  volumeMode: PineVolumeMode,
): PineKline[] {
  return candles.map((c) => {
    const openTime = secToMs(c.time);
    let volume = c.volume;
    if (volumeMode === "approx-base") {
      const ohlc4 = (c.open + c.high + c.low + c.close) / 4;
      volume = ohlc4 > 0 ? volume / ohlc4 : 0;
    }
    return {
      openTime,
      closeTime: openTime + intervalSec * 1000 - 1,
      open: c.open * scale,
      high: c.high * scale,
      low: c.low * scale,
      close: c.close * scale,
      volume,
    };
  });
}

const WEEK_SEC = 604_800;
/** ISO weeks start on Monday; the Unix epoch is a Thursday. */
const MONDAY_OFFSET_SEC = 345_600;

export function bucketTime(time: number, bucketSec: number): number {
  if (bucketSec === WEEK_SEC) return Math.floor((time - MONDAY_OFFSET_SEC) / bucketSec) * bucketSec + MONDAY_OFFSET_SEC;
  return Math.floor(time / bucketSec) * bucketSec;
}

/**
 * Roll finer bars up to `bucketSec` **before** any indicator runs. Volume is
 * summed; a bucket with no source bars is simply absent (gaps stay gaps).
 */
export function aggregateCandles(bars: PineCandle[], bucketSec: number): PineCandle[] {
  if (bucketSec <= 0) throw new Error("bucketSec must be positive");
  const out: PineCandle[] = [];
  for (const c of bars) {
    const t = bucketTime(c.time, bucketSec);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else if (last && last.time > t) {
      throw new Error("aggregateCandles: input bars must be ascending");
    } else {
      out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

/**
 * Stable fingerprint of a candle window for result caching. Every bar's time,
 * close and volume is mixed in (FNV-1a), so any edit anywhere in the window
 * changes the key; ten thousand bars hash in about a millisecond.
 */
export function fingerprintCandles(candles: PineCandle[]): string {
  const n = candles.length;
  if (n === 0) return "empty";
  let h = 2166136261;
  const mix = (x: number) => {
    const s = String(x);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    mix(c.time);
    mix(c.close);
    mix(c.volume);
  }
  const last = candles[n - 1]!;
  mix(last.high);
  mix(last.low);
  return `${n}:${candles[0]!.time}:${last.time}:${h.toString(16)}`;
}
