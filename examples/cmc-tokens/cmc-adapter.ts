import type {
  CandleRequest,
  MarketDataSource,
  OpenChartsAdapter,
  Quote,
} from "../../src/adapter/types.ts";
import type { Timeframe } from "../../src/pages/trading/constants.ts";
import { getCandleBucketTime } from "../../src/pages/trading/utils.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";
import { setSymbolMarkers, type SymbolMarker } from "../../src/services/symbol-markers.ts";

/**
 * CMC new-listing tokens (backtest set + real bot trades) as read-only instruments,
 * served as static JSON from `cmc-data/` (built by build-cmc-data.py). The bundled demo
 * instruments and paper engine stay available alongside them.
 *
 * Each token file holds 1-minute bars from 24h before entry to 48h after, plus markers
 * (BUY / SELL 75% / EXIT, REAL BUY / REAL SELL, sim exits) that the chart draws.
 */

interface CmcEntry {
  name: string;
  file: string;
  category: string;
  label: string;
  tickSize: number;
}

interface CmcSeries {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  m: [number, string, string][];
}

const BASE = `${import.meta.env.BASE_URL}cmc-data/`;
const CACHE_MAX = 40;

function spec(e: CmcEntry): Symbol {
  return {
    id: e.name,
    name: e.name,
    displayName: e.label,
    category: e.category,
    contractSize: 1,
    tickSize: e.tickSize,
    tickValue: e.tickSize,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  } as Symbol;
}

/** Roll 1-minute bars up to `timeframe`, using the chart's own bucket boundaries. */
export function aggregate(s: CmcSeries, timeframe: string): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const time = timeframe === "1m" ? s.t[i]! : getCandleBucketTime(s.t[i]! * 1000, timeframe as Timeframe);
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, s.h[i]!);
      last.low = Math.min(last.low, s.l[i]!);
      last.close = s.c[i]!;
      last.volume = (last.volume ?? 0) + s.v[i]!;
    } else {
      out.push({ time, open: s.o[i]!, high: s.h[i]!, low: s.l[i]!, close: s.c[i]!, volume: s.v[i]! });
    }
  }
  return out;
}

export async function createCmcAdapter(): Promise<OpenChartsAdapter> {
  const { createDemoAdapter } = await import("../../src/adapter/demo.ts");
  const demo = createDemoAdapter();

  const res = await fetch(`${BASE}symbols.json`);
  if (!res.ok) throw new Error(`Could not load the CMC token list (${res.status})`);
  const entries = (await res.json()) as CmcEntry[];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const cache = new Map<string, Promise<CmcSeries>>();

  const load = (e: CmcEntry): Promise<CmcSeries> => {
    let p = cache.get(e.name);
    if (!p) {
      p = fetch(`${BASE}t/${e.file}.json`).then(async (r) => {
        if (!r.ok) throw new Error(`Could not load candles for ${e.name} (${r.status})`);
        const s = (await r.json()) as CmcSeries;
        const markers: SymbolMarker[] = s.m.map(([time, kind, text]) => ({ time, kind, text }));
        setSymbolMarkers(e.name, markers);
        return s;
      });
      p.catch(() => cache.delete(e.name));
      cache.set(e.name, p);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    return p;
  };

  const marketData: MarketDataSource = {
    ...demo.marketData,

    getSymbols: async () => [...(await demo.marketData.getSymbols()), ...entries.map(spec)],

    getCandles: async (req: CandleRequest) => {
      const e = byName.get(req.symbol);
      if (!e) return demo.marketData.getCandles(req);
      let bars = aggregate(await load(e), req.timeframe);
      if (req.fromMs != null) bars = bars.filter((b) => b.time * 1000 >= req.fromMs!);
      if (req.toMs != null) bars = bars.filter((b) => b.time * 1000 < req.toMs!);
      if (req.limit != null && req.limit > 0 && bars.length > req.limit) bars = bars.slice(-req.limit);
      return bars;
    },

    getQuote: async (symbol: string): Promise<Quote | null> => {
      const e = byName.get(symbol);
      if (!e) return demo.marketData.getQuote ? demo.marketData.getQuote(symbol) : null;
      const s = await load(e);
      const px = s.c[s.c.length - 1];
      return px == null ? null : { symbol, bid: px, ask: px, timestamp: s.t[s.t.length - 1]! * 1000 };
    },
  };

  return { name: "cmc-tokens", marketData, trading: demo.trading, storage: demo.storage };
}
