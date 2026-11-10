/**
 * Runs every bundled Pine script through the PineTS runner, on real ZEC/USDT
 * hourly history and on hand-built fixtures, and checks a handful of values
 * against independent TypeScript ports of the same maths.
 */
import { describe, expect, it } from "vitest";
import { pineRunKey } from "../pine/cache-key.ts";
import { runPineScript, describePineScript } from "../pine/runner.ts";
import { PINE_SCRIPTS } from "../pine/registry.ts";
import type { PineCandle, PineRunRequest, PineRunSuccess } from "../pine/types.ts";

// The ZEC history is generated locally (public/historical is not committed), so
// the real-data suite skips cleanly when it is absent. Node's fs is loaded
// through a non-literal specifier because the project ships no Node typings.
const fsSpecifier = "node:fs";
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: string) => string;
};
const ZEC_FILE = "public/historical/CSV_ZECUSDT_1H_2019_2026_1F503C68.json";
const zecAvailable = fs.existsSync(ZEC_FILE);
const zecAll: PineCandle[] = zecAvailable ? (JSON.parse(fs.readFileSync(ZEC_FILE, "utf8")) as { candles: PineCandle[] }).candles : [];
const zec = zecAll.slice(-1500);

function request(scriptId: string, candles: PineCandle[], extra: Partial<PineRunRequest> = {}): PineRunRequest {
  return {
    scriptId,
    symbol: "ZECUSDT",
    timeframe: "1h",
    intervalSec: 3600,
    candles,
    params: {},
    volumeMode: "quote",
    ...extra,
  };
}

async function runOk(scriptId: string, candles: PineCandle[], extra: Partial<PineRunRequest> = {}): Promise<PineRunSuccess> {
  const res = await runPineScript(request(scriptId, candles, extra));
  if (!res.ok) throw new Error(`${scriptId} failed at ${res.stage}: ${res.error}`);
  return res;
}

function line(res: PineRunSuccess, title: string) {
  const l = res.lines.find((p) => p.title === title);
  if (!l) throw new Error(`plot "${title}" missing; have ${res.lines.map((p) => p.title).join(", ")}`);
  return l;
}

const lastValue = (res: PineRunSuccess, title: string) => line(res, title).points.at(-1)!.value;

// ── Independent ports ────────────────────────────────────────────────────────

function sma(src: number[], len: number): number[] {
  return src.map((_, i) => {
    if (i < len - 1) return NaN;
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) {
      if (Number.isNaN(src[j]!)) return NaN;
      s += src[j]!;
    }
    return s / len;
  });
}

function rma(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(prev)) {
      let s = 0;
      let ok = i >= len - 1;
      for (let j = i - len + 1; ok && j <= i; j++) {
        if (Number.isNaN(src[j]!)) ok = false;
        else s += src[j]!;
      }
      if (ok) prev = s / len;
    } else {
      prev = (src[i]! + (len - 1) * prev) / len;
    }
    out[i] = prev;
  }
  return out;
}

/** TradingView's ta.rsi: RMA of gains / RMA of losses. */
function rsi(close: number[], len: number): number[] {
  const up = close.map((c, i) => (i === 0 ? NaN : Math.max(c - close[i - 1]!, 0)));
  const down = close.map((c, i) => (i === 0 ? NaN : -Math.min(c - close[i - 1]!, 0)));
  const u = rma(up, len);
  const d = rma(down, len);
  return u.map((uv, i) => {
    const dv = d[i]!;
    if (Number.isNaN(uv) || Number.isNaN(dv)) return NaN;
    if (dv === 0) return 100;
    if (uv === 0) return 0;
    return 100 - 100 / (1 + uv / dv);
  });
}

function twoLineCounter(c: PineCandle[], i: number): [number, number] {
  let line1 = 0;
  let line2 = 0;
  for (let k = 1; k <= 21; k++) {
    const a = c[i - k];
    const b = c[i - k + 1];
    if (!a || !b) return [NaN, NaN];
    const avgPrev = (a.open + a.close) / 2;
    const quarter = (b.open + b.high + b.low + b.close) * 0.25;
    if (avgPrev < quarter) line1 += 1;
    else if (avgPrev > quarter) line2 += 1;
  }
  return [line1, line2];
}

function haRatioSeries(c: PineCandle[]): number[] {
  const haClose = c.map((b) => (b.open + b.high + b.low + b.close) / 4);
  const haOpen: number[] = [];
  for (let i = 0; i < c.length; i++) {
    haOpen.push(i === 0 ? (c[0]!.open + c[0]!.close) / 2 : (haOpen[i - 1]! + haClose[i - 1]!) / 2);
  }
  const ratio: number[] = [];
  for (let i = 0; i < c.length; i++) {
    let green = 0;
    let red = 0;
    for (let k = 0; k < 8; k++) {
      const j = i - k;
      if (j < 0) continue; // Pine: isGreen[i] is na -> `na ? 1 : 0` evaluates false -> 0
      if (haClose[j]! > haOpen[j]!) green += 1;
      else red += 1;
    }
    ratio.push(red === 0 ? green : green / red);
  }
  return ratio;
}

function whaleMoneyFlow(c: PineCandle[]): { whale: number[]; price: number[] } {
  const n = c.length;
  const adj = c.map((b) => (b.close === b.high && b.close === b.low) || b.high === b.low ? 0 : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume);
  const sum = (src: number[], len: number) => src.map((_, i) => (i < len - 1 ? NaN : src.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0)));
  const wmf = sum(adj, 10).map((v, i) => v / sum(c.map((b) => b.volume), 10)[i]!);
  const change = c.map((b, i) => (i === 0 ? NaN : b.close - c[i - 1]!.close));
  const upSrc = c.map((b, i) => (Number.isNaN(change[i]!) ? NaN : b.volume * (change[i]! <= 0 ? 0 : b.close)));
  const dnSrc = c.map((b, i) => (Number.isNaN(change[i]!) ? NaN : b.volume * (change[i]! >= 0 ? 0 : b.close)));
  const upper = sum(upSrc, 14);
  const lower = sum(dnSrc, 14);
  const strength = upper.map((u, i) => {
    const l = lower[i]!;
    if (Number.isNaN(u) || Number.isNaN(l)) return NaN;
    if (l === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / l);
  });
  const mlu = rma(change.map((x) => (Number.isNaN(x) ? NaN : Math.max(x, 0))), 12);
  const mld = rma(change.map((x) => (Number.isNaN(x) ? NaN : -Math.min(x, 0))), 12);
  const price = mlu.map((u, i) => {
    const d = mld[i]!;
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  });
  const whale = strength.map((s, i) => s + wmf[i]!);
  return { whale: whale.slice(0, n), price };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function synthetic(n: number, opts: { flat?: boolean; highEqLow?: boolean; zeroVolume?: boolean; gapEvery?: number; scale?: number } = {}): PineCandle[] {
  const out: PineCandle[] = [];
  let t = 1_700_000_000;
  let price = 100;
  for (let i = 0; i < n; i++) {
    if (opts.gapEvery && i > 0 && i % opts.gapEvery === 0) t += 3600 * 3; // three missing hours
    const drift = opts.flat ? 0 : Math.sin(i / 9) * 2 + Math.cos(i / 23) * 3;
    const open = price;
    const close = opts.flat ? price : Math.max(1, price + drift);
    const high = opts.flat || opts.highEqLow ? Math.max(open, close) : Math.max(open, close) + 1;
    const low = opts.flat || opts.highEqLow ? Math.min(open, close) : Math.min(open, close) - 1;
    const s = opts.scale ?? 1;
    out.push({
      time: t,
      open: open * s,
      high: (opts.highEqLow ? Math.max(open, close) : high) * s,
      low: (opts.highEqLow ? Math.max(open, close) : low) * s,
      close: (opts.highEqLow ? Math.max(open, close) : close) * s,
      volume: opts.zeroVolume ? 0 : 1000 + ((i * 37) % 500),
    });
    if (opts.highEqLow) {
      const c = out[out.length - 1]!;
      c.open = c.high;
      c.close = c.high;
    }
    price = close;
    t += 3600;
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!zecAvailable)("Pine scripts on ZEC/USDT 1h", () => {
  it("runs every registered script without failure", async () => {
    for (const spec of PINE_SCRIPTS) {
      const res = await runPineScript(request(spec.id, zec));
      expect(res.ok, `${spec.id}: ${res.ok ? "" : res.error}`).toBe(true);
      if (!res.ok) continue;
      expect(res.meta.bars).toBe(1500);
      expect(res.meta.firstTime).toBe(zec[0]!.time);
      expect(res.meta.lastTime).toBe(zec.at(-1)!.time);
      // every plotted time must be a loaded candle time
      const times = new Set(zec.map((c) => c.time));
      for (const l of res.lines) for (const p of l.points) expect(times.has(p.time)).toBe(true);
      for (const s of res.shapes) expect(times.has(s.time)).toBe(true);
    }
  }, 60_000);

  it("RSI-14 + SMA100 (compat v5) matches an independent RSI port", async () => {
    const res = await runOk("pine:rsi-sma100", zec);
    const closes = zec.map((c) => c.close);
    const r = rsi(closes, 14);
    const rs = sma(r, 100);
    for (const i of [1499, 1200, 900, 400]) {
      expect(line(res, "RSI").points[i]!.value).toBeCloseTo(r[i]!, 6);
      expect(line(res, "RSISMA").points[i]!.value).toBeCloseTo(rs[i]!, 6);
    }
    expect(res.hlines.map((h) => h.value).sort((a, b) => a - b)).toEqual([30, 50, 70]);
    expect(line(res, "RSISMA").style).toBe("area");
    expect(line(res, "RSI").overlay).toBe(false);
  });

  it("Two Line Counter matches the 21-offset comparison", async () => {
    const res = await runOk("pine:two-line-counter", zec);
    for (const i of [1499, 1000, 300, 25]) {
      const [l1, l2] = twoLineCounter(zec, i);
      expect(line(res, "Line 1").points[i]!.value).toBe(l1);
      expect(line(res, "Line 2").points[i]!.value).toBe(l2);
      expect(l1 + l2).toBeLessThanOrEqual(21);
    }
  });

  it("HA green:red ratio MAs match a recursive-HA port", async () => {
    const res = await runOk("pine:ha-ratio-ma", zec);
    const ratio = haRatioSeries(zec);
    const m10 = sma(ratio, 10);
    const m50 = sma(ratio, 50);
    const m200 = sma(ratio, 200);
    for (const i of [1499, 1100, 600, 250]) {
      expect(line(res, "10-Period MA of Green:Red Ratio").points[i]!.value).toBeCloseTo(m10[i]!, 6);
      expect(line(res, "50-Period MA of Green:Red Ratio").points[i]!.value).toBeCloseTo(m50[i]!, 6);
      expect(line(res, "200-Period MA of Green:Red Ratio").points[i]!.value).toBeCloseTo(m200[i]!, 6);
    }
    // warm-up: the 200 MA is na before 200 bars (minus the first-bar HA seed)
    expect(line(res, "200-Period MA of Green:Red Ratio").points[150]!.value).toBeNull();
  });

  it("Whale money flow matches an independent port", async () => {
    const res = await runOk("pine:whale-mf", zec);
    const { whale, price } = whaleMoneyFlow(zec);
    for (const i of [1499, 1000, 500, 60]) {
      expect(line(res, "Whale Money Flow").points[i]!.value).toBeCloseTo(whale[i]!, 5);
      expect(line(res, "Price").points[i]!.value).toBeCloseTo(price[i]!, 5);
    }
  });

  it("Dip Hunter produces signals, bar colours, background, entry lines and the meter table", async () => {
    const res = await runOk("pine:dip-hunter", zec);
    expect(res.shapes.length).toBeGreaterThan(0);
    expect(res.shapes.every((s) => s.shape === "triangleup" && s.location === "belowbar")).toBe(true);
    expect(res.bgcolors.length).toBe(res.shapes.length);
    expect(res.barcolors.length).toBe(1500);
    expect(res.drawingLines.length).toBeGreaterThan(0);
    for (const l of res.drawingLines) expect(l.fromPrice).toBe(l.toPrice);
    expect(res.tables.length).toBe(1);
    expect(res.tables[0]!.rows[0]![0]!.text).toBe("Overheated");
    expect(res.tables[0]!.rows[0]!.at(-1)!.text).toBe("Dip");
    expect(res.tables[0]!.rows[0]!.length).toBe(62);
    // EMAs are off by default: plots exist but are all na
    expect(line(res, "Fast EMA").points.every((p) => p.value === null)).toBe(true);
    const withEmas = await runOk("pine:dip-hunter", zec, { params: { showEMAs: true } });
    expect(lastValue(withEmas, "Fast EMA")).toBeGreaterThan(0);
    expect(line(withEmas, "Fast EMA").overlay).toBe(true);
  });

  it("Top Finder plots support/resistance inside the price range with DIP/TOP labels", async () => {
    const res = await runOk("pine:top-finder", zec);
    const sup = line(res, "Dip Support");
    const resist = line(res, "Top Resistance");
    const minLow = Math.min(...zec.map((c) => c.low));
    const maxHigh = Math.max(...zec.map((c) => c.high));
    for (const p of sup.points) if (p.value !== null) expect(p.value).toBeGreaterThan(minLow * 0.5);
    for (const p of resist.points) if (p.value !== null) expect(p.value).toBeLessThan(maxHigh * 1.5);
    const dips = res.shapes.filter((s) => s.title === "Dip Signal");
    const tops = res.shapes.filter((s) => s.title === "Top Signal");
    expect(dips.length).toBeGreaterThan(0);
    expect(tops.length).toBeGreaterThan(0);
    expect(dips[0]!.text).toBe("DIP");
    expect(tops[0]!.text).toBe("TOP");
    // one quality label per signal, anchored at the same bar
    expect(res.labels.length).toBe(dips.length + tops.length);
    expect(res.labels.every((l) => /^Q: \d+%$/.test(l.text))).toBe(true);
    const signalTimes = new Set([...dips, ...tops].map((s) => s.time));
    for (const l of res.labels) expect(signalTimes.has(l.time)).toBe(true);
    const dyn = await runOk("pine:top-finder", zec, { params: { dipMethod: "Dynamic" } });
    expect(lastValue(dyn, "Dip Support")).not.toBe(lastValue(res, "Dip Support"));
  });

  it("Decision Tree emits BUY markers only", async () => {
    const res = await runOk("pine:decision-tree", zec);
    expect(res.lines.length).toBe(0);
    expect(res.shapes.length).toBeGreaterThan(0);
    expect(res.shapes.every((s) => s.text === "BUY" && s.shape === "labelup")).toBe(true);
    expect(res.alerts.length).toBe(res.shapes.length);
  });

  it("BuyTheDip strategy fills agree with the independent simulator", async () => {
    const res = await runOk("pine:buy-the-dip", zec);
    expect(res.strategy).toBeDefined();
    const s = res.strategy!;
    expect(s.trades.length).toBeGreaterThan(5);
    expect(s.crossCheck.mismatches).toEqual([]);
    expect(s.crossCheck.passed).toBe(true);
    expect(s.crossCheck.runtimeTrades).toBe(s.crossCheck.simulatorTrades);
    expect(s.winTrades + s.lossTrades).toBe(s.trades.length);
    // entries fill at the next bar open
    const byTime = new Map(zec.map((c) => [c.time, c]));
    for (const t of s.trades) expect(t.entryPrice).toBeCloseTo(byTime.get(t.entryTime)!.open, 8);
    expect(line(res, "Dip Line").overlay).toBe(true);
    expect(line(res, "ATR Take Profit").style).toBe("cross");
  });

  it("BuyTheDip from the dataset's first bars: PineTS's bar-0 ta.tr deviation is detected and explained", async () => {
    // ZEC's first dip is on bar 9, inside ATR(10)'s warm-up. TradingView's
    // ta.tr is na on bar 0 (so the entry has na exit levels and never closes);
    // PineTS uses high-low there and closes trades. The cross-check must fail
    // loudly rather than present either as verified.
    const res = await runOk("pine:buy-the-dip", zecAll.slice(0, 1500));
    const s = res.strategy!;
    expect(s.crossCheck.passed).toBe(false);
    expect(s.crossCheck.mismatches[0]).toMatch(/inside the ATR\(10\) warm-up/);
    expect(s.trades.length).toBeGreaterThan(5);
    // Starting the window after that dip, both implementations agree again.
    const later = await runOk("pine:buy-the-dip", zecAll.slice(20, 1520));
    expect(later.strategy!.crossCheck.mismatches).toEqual([]);
  });

  it("describes script inputs with their defaults", () => {
    const inputs = describePineScript("pine:dip-hunter");
    expect(inputs.find((i) => i.key === "volLookback")?.defval).toBe(65);
    expect(inputs.find((i) => i.key === "dipThreshold")?.defval).toBe(2);
    expect(inputs.find((i) => i.key === "entrySrcOpt")?.options).toEqual(["Low", "Close", "Dip % Level"]);
    const strat = describePineScript("pine:buy-the-dip");
    expect(strat.map((i) => [i.key, i.defval])).toEqual([["atn", 10], ["tpm", 2], ["slm", 2], ["n", 7]]);
    expect(describePineScript("pine:top-finder").find((i) => i.key === "dipMethod")?.defval).toBe("Hybrid");
  });

  it("cache key changes with params, window and data", () => {
    const a = pineRunKey(request("pine:dip-hunter", zec));
    expect(pineRunKey(request("pine:dip-hunter", zec))).toBe(a);
    expect(pineRunKey(request("pine:dip-hunter", zec, { params: { emaFast: 21 } }))).not.toBe(a);
    expect(pineRunKey(request("pine:dip-hunter", zec.slice(1)))).not.toBe(a);
    const edited = zec.map((c, i) => (i === 700 ? { ...c, close: c.close * 1.01 } : c));
    expect(pineRunKey(request("pine:dip-hunter", edited))).not.toBe(a);
  });
});

describe("Pine scripts on fixtures", () => {
  it("flat prices: every script runs; counters are zero", async () => {
    const flat = synthetic(300, { flat: true });
    for (const spec of PINE_SCRIPTS) {
      const res = await runPineScript(request(spec.id, flat));
      expect(res.ok, `${spec.id}: ${res.ok ? "" : res.error}`).toBe(true);
    }
    const tlc = await runOk("pine:two-line-counter", flat);
    expect(lastValue(tlc, "Line 1")).toBe(0);
    expect(lastValue(tlc, "Line 2")).toBe(0);
    const ratio = await runOk("pine:ha-ratio-ma", flat);
    expect(lastValue(ratio, "10-Period MA of Green:Red Ratio")).toBe(0);
    const strat = await runOk("pine:buy-the-dip", flat);
    expect(strat.strategy!.trades).toEqual([]);
    expect(strat.strategy!.crossCheck.passed).toBe(true);
  });

  it("flags a position opened before ATR exists as stuck (na exit levels), like the Pine source", async () => {
    const data = synthetic(300);
    // A dip inside the ATR(10) warm-up: close below the previous 7 lows on bar 8.
    data[8]!.close = data[8]!.low = Math.min(...data.slice(1, 8).map((c) => c.low)) - 5;
    data[8]!.open = data[8]!.high = data[8]!.close + 1;
    const res = await runOk("pine:buy-the-dip", data);
    const s = res.strategy!;
    expect(s.openTrade?.entryTime).toBe(data[9]!.time);
    expect(s.openTradeStuck).toBe(true);
    expect(s.trades).toEqual([]);
    expect(s.crossCheck.passed).toBe(true);
    // The same prices later in the window (ATR defined) do open and close trades.
    const later = synthetic(300);
    later[60]!.close = later[60]!.low = Math.min(...later.slice(53, 60).map((c) => c.low)) - 5;
    later[60]!.open = later[60]!.high = later[60]!.close + 1;
    const res2 = await runOk("pine:buy-the-dip", later);
    expect(res2.strategy!.openTradeStuck).toBe(false);
    expect(res2.strategy!.trades.length + (res2.strategy!.openTrade ? 1 : 0)).toBeGreaterThan(0);
  });

  it("high == low bars do not divide by zero", async () => {
    const res = await runOk("pine:whale-mf", synthetic(300, { highEqLow: true }));
    for (const p of line(res, "Whale Money Flow").points.slice(30)) expect(p.value).not.toBeNull();
    const dh = await runOk("pine:dip-hunter", synthetic(300, { highEqLow: true }));
    expect(dh.barcolors.length).toBe(300);
  });

  it("zero-volume datasets are refused for volume-dependent scripts and accepted for the rest", async () => {
    const zero = synthetic(300, { zeroVolume: true });
    for (const spec of PINE_SCRIPTS) {
      const res = await runPineScript(request(spec.id, zero));
      if (spec.usesVolume) {
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.stage).toBe("unsupported");
      } else {
        expect(res.ok, `${spec.id}: ${res.ok ? "" : res.error}`).toBe(true);
      }
    }
  });

  it("missing bars stay gaps and are counted", async () => {
    const gappy = synthetic(300, { gapEvery: 50 });
    const res = await runOk("pine:ha-ratio-ma", gappy);
    expect(res.meta.gaps).toBe(5);
    expect(res.meta.missingBars).toBe(15);
    expect(line(res, "10-Period MA of Green:Red Ratio").points.length).toBe(300);
  });

  it("very low token prices are normalised so overlay levels keep their precision", async () => {
    const base = synthetic(300);
    const tiny = synthetic(300, { scale: 1e-9 });
    const a = await runOk("pine:top-finder", base);
    const b = await runOk("pine:top-finder", tiny);
    expect(b.meta.priceScale).toBeGreaterThan(1e8);
    expect(a.meta.priceScale).toBe(1);
    const la = line(a, "Dip Support").points;
    const lb = line(b, "Dip Support").points;
    for (let i = 250; i < 300; i++) {
      expect(lb[i]!.value! / 1e-9).toBeCloseTo(la[i]!.value!, 4);
    }
    const sa = await runOk("pine:buy-the-dip", base);
    const sb = await runOk("pine:buy-the-dip", tiny);
    expect(sb.strategy!.trades.length).toBe(sa.strategy!.trades.length);
    expect(sb.strategy!.crossCheck.passed).toBe(true);
  });

  it("first bars: plots are na until the lookback is satisfied, never garbage", async () => {
    const res = await runOk("pine:ha-ratio-ma", synthetic(300));
    const m50 = line(res, "50-Period MA of Green:Red Ratio").points;
    expect(m50[10]!.value).toBeNull();
    expect(m50[60]!.value).not.toBeNull();
  });

  it("rejects duplicated or unordered timestamps", async () => {
    const dup = synthetic(50);
    dup[10] = { ...dup[9]! };
    const r1 = await runPineScript(request("pine:two-line-counter", dup));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.stage).toBe("validate");
    const bad = synthetic(50);
    bad[5]!.high = bad[5]!.low - 1;
    const r2 = await runPineScript(request("pine:two-line-counter", bad));
    expect(r2.ok).toBe(false);
  });

  it("honours maxBars by computing on the most recent window only", async () => {
    const data = synthetic(900);
    const res = await runOk("pine:two-line-counter", data, { maxBars: 400 });
    expect(res.meta.bars).toBe(400);
    expect(res.meta.firstTime).toBe(data.at(-400)!.time);
  });
});
