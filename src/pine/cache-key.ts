/**
 * Cache key for a Pine run: everything that can change the output. Lives
 * apart from the runner so the main bundle can key the cache without pulling
 * PineTS in (the runner only ever loads inside the worker or lazily).
 */
import { fingerprintCandles } from "./data.ts";
import type { PineRunRequest } from "./types.ts";

export const DEFAULT_MAX_BARS = 10_000;

export function pineRunKey(req: PineRunRequest): string {
  const params = Object.keys(req.params)
    .sort()
    .map((k) => `${k}=${String(req.params[k])}`)
    .join("&");
  const maxBars = req.maxBars ?? DEFAULT_MAX_BARS;
  const window = req.candles.length > maxBars ? req.candles.slice(-maxBars) : req.candles;
  return `${req.scriptId}|${req.symbol}|${req.timeframe}|${req.volumeMode}|${params}|${fingerprintCandles(window)}`;
}
