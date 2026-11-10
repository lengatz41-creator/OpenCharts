import type { OpenChartsAdapter, CandleRequest } from "./types.ts";
import type { Candle, Symbol } from "../services/schemas.ts";

type Meta = {
  symbol: string;
  displayName: string;
  tickSize: number;
};
export type CsvEvent = { time: number; event: string; min_from_entry?: string };
export type CsvDataset = { candles: Candle[]; events: CsvEvent[] };

const intervals: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
};
const pending = new Map<string, Promise<CsvDataset>>();
let manifestPending: Promise<Meta[]> | undefined;

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load ${url} (HTTP ${response.status})`);
    return (await response.json()) as T;
  });
}
function manifest(): Promise<Meta[]> {
  manifestPending ??= fetchJson<Meta[]>("/historical/manifest.json");
  return manifestPending;
}
export function readCsvDataset(symbol: string): Promise<CsvDataset> {
  if (!/^CSV_[A-Z0-9_]+$/.test(symbol)) {
    return Promise.reject(new Error(`Invalid CSV symbol ${symbol}`));
  }
  let request = pending.get(symbol);
  if (!request) {
    request = fetchJson<CsvDataset>(`/historical/${encodeURIComponent(symbol)}.json`);
    pending.set(symbol, request);
    // Failed loads must be retryable after the source files are corrected.
    void request.catch(() => pending.delete(symbol));
  }
  return request;
}
function bucket(t: number, tf: string): number {
  const secs = intervals[tf];
  if (!secs) throw new Error(`Unsupported timeframe: ${tf}`);
  // ISO Monday start for weekly aggregation; Unix epoch itself starts Thursday.
  if (tf === "1w") return Math.floor((t - 345600) / secs) * secs + 345600;
  return Math.floor(t / secs) * secs;
}
function aggregate(bars: Candle[], tf: string): Candle[] {
  if (tf === "1m") return bars;
  const output: Candle[] = [];
  for (const c of bars) {
    const t = bucket(c.time, tf);
    const previous = output[output.length - 1];
    if (previous?.time === t) {
      previous.high = Math.max(previous.high, c.high);
      previous.low = Math.min(previous.low, c.low);
      previous.close = c.close;
      previous.volume += c.volume;
    } else {
      output.push({ time: t, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume });
    }
  }
  return output;
}
function quoteSymbol(m: Meta): Symbol {
  return {
    id: m.symbol, name: m.symbol, displayName: m.displayName, category: "CRYPTO",
    contractSize: 1, tickSize: m.tickSize, tickValue: m.tickSize,
    marginPercent: 1, maxLeverage: 1, commission: 0,
    swapLong: 0, swapShort: 0, tradingHoursStart: null,
    tradingHoursEnd: null, isActive: true,
  };
}
async function candlesFor(request: CandleRequest): Promise<Candle[]> {
  const series = aggregate((await readCsvDataset(request.symbol)).candles, request.timeframe);
  const range = series.filter((c) =>
    (request.fromMs == null || c.time * 1000 >= request.fromMs) &&
    (request.toMs == null || c.time * 1000 < request.toMs)
  );
  return request.limit != null && request.limit > 0
    ? range.slice(-Math.floor(request.limit)) : range;
}
export function createCsvHistoricalAdapter(): OpenChartsAdapter {
  return {
    name: "csv-historical-readonly",
    marketData: {
      getSymbols: async () => (await manifest()).map(quoteSymbol),
      getCandles: candlesFor,
      getQuote: async (symbol) => {
        const bars = (await readCsvDataset(symbol)).candles;
        const last = bars[bars.length - 1];
        return last
          ? { symbol, bid: last.close, ask: last.close, timestamp: last.time * 1000 }
          : null;
      },
      subscribe: () => () => {}, // Static historical files: no live stream.
      getConnectionState: () => "connected",
      connect: () => {},
      disconnect: () => {},
      onConnectionChange: (handler) => {
        handler("connected");
        return () => {};
      },
    },
  };
}
