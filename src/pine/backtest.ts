/**
 * Independent fill simulator for the BuyTheDip strategy.
 *
 * This is *not* the PineTS broker. It exists so the fills the chart shows have
 * been produced twice, by two unrelated implementations, under one explicit
 * set of assumptions. The runner compares both trade lists and only reports
 * the strategy as cross-checked when they agree.
 *
 * Assumptions (TradingView defaults for a `strategy()` without
 * calc_on_every_tick / calc_on_order_fills, qty 1, no commission or slippage):
 *  1. The script runs once per bar, on the close.
 *  2. `strategy.entry` placed on bar i fills at bar i+1 open (market order).
 *  3. pyramiding = 1: an entry while a position is open is ignored.
 *  4. `strategy.exit(stop, limit)` placed on bar i is live from bar i+1.
 *     The limit fills at the limit price (at the open if the bar opens above
 *     it); the stop fills at the stop price (at the open if the bar opens
 *     below it).
 *  5. If one bar touches both levels, price is assumed to visit the extreme
 *     closer to the open first (TradingView's broker-emulator rule); the
 *     level on that side fills and the other is cancelled.
 *  6. ATR is `sma(tr, n)[1]`, i.e. the previous bar's value. While it is `na`
 *     (the first bars) the exit levels are `na` and no exit order exists.
 *  7. The TP/SL are fixed at the values computed on the fill bar
 *     (`valuewhen(bought, ..., 0)`).
 */
import type { PineCandle, PineTrade } from "./types.ts";

export interface BuyTheDipParams {
  atrLength: number;
  takeProfitMult: number;
  stopLossMult: number;
  dipLength: number;
}

export const BUY_THE_DIP_DEFAULTS: BuyTheDipParams = {
  atrLength: 10,
  takeProfitMult: 2,
  stopLossMult: 2,
  dipLength: 7,
};

export const BUY_THE_DIP_ASSUMPTIONS: string[] = [
  "Script evaluated once per bar on the close; qty 1, no commission, no slippage.",
  "Entry market order fills at the next bar's open; pyramiding = 1.",
  "Exit stop/limit are live from the bar after they are placed.",
  "Limit fills at the limit (or the open if it gaps above); stop at the stop (or the open if it gaps below).",
  "Both levels in one bar: the extreme closer to the open is assumed to trade first.",
  "ATR = SMA(true range, n) of the previous bar; exits do not exist while it is na.",
];

export interface SimulatedTrade extends PineTrade {
  entryIndex: number;
  exitIndex: number | null;
  takeProfit: number;
  stopLoss: number;
}

/** True range as Pine's `tr` (v4) / `ta.tr` (v5, handleNa=false): na on the first bar. */
function trueRange(c: PineCandle, prev: PineCandle | undefined): number {
  if (!prev) return NaN;
  return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

export function simulateBuyTheDip(
  candles: PineCandle[],
  params: BuyTheDipParams = BUY_THE_DIP_DEFAULTS,
): { trades: SimulatedTrade[]; open: SimulatedTrade | null } {
  const n = candles.length;
  const { atrLength, takeProfitMult, stopLossMult, dipLength } = params;
  const tr = candles.map((c, i) => trueRange(c, candles[i - 1]));
  // sma(tr, atrLength) on bar i (na until enough non-na values exist)
  const smaTr = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < atrLength) continue;
    let sum = 0;
    let ok = true;
    for (let j = i - atrLength + 1; j <= i; j++) {
      const v = tr[j]!;
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) smaTr[i] = sum / atrLength;
  }
  const lowest = (i: number): number => {
    if (i - dipLength + 1 < 0) return NaN;
    let m = Infinity;
    for (let j = i - dipLength + 1; j <= i; j++) m = Math.min(m, candles[j]!.low);
    return m;
  };

  const trades: SimulatedTrade[] = [];
  let open: SimulatedTrade | null = null;
  let pendingEntry = false;
  let exitLive = false;
  let seq = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    // ── Broker: orders placed on bar i-1 act on bar i ─────────────────
    if (open && exitLive) {
      const { takeProfit, stopLoss } = open;
      const hitTp = c.high >= takeProfit;
      const hitSl = c.low <= stopLoss;
      let exitPrice: number | null = null;
      if (hitTp && hitSl) {
        const highFirst = c.high - c.open < c.open - c.low;
        exitPrice = highFirst ? Math.max(takeProfit, c.open) : Math.min(stopLoss, c.open);
      } else if (hitTp) {
        exitPrice = Math.max(takeProfit, c.open);
      } else if (hitSl) {
        exitPrice = Math.min(stopLoss, c.open);
      }
      if (exitPrice !== null) {
        open.exitId = "Stop";
        open.exitTime = c.time;
        open.exitIndex = i;
        open.exitPrice = exitPrice;
        open.profit = (exitPrice - open.entryPrice) * open.size;
        trades.push(open);
        open = null;
        exitLive = false;
      }
    }
    if (pendingEntry && !open) {
      seq += 1;
      open = {
        id: `sim_${seq}`,
        entryId: "Buy",
        entryTime: c.time,
        entryIndex: i,
        entryPrice: c.open,
        size: 1,
        exitId: null,
        exitTime: null,
        exitIndex: null,
        exitPrice: null,
        profit: null,
        takeProfit: NaN,
        stopLoss: NaN,
      };
      exitLive = false;
    }
    pendingEntry = false;

    // ── Script: runs on the close of bar i ────────────────────────────
    const atrPrev = i > 0 ? smaTr[i - 1]! : NaN; // sma(tr, n)[1]
    if (open && open.entryIndex === i) {
      // `bought` is true on the fill bar: fix TP/SL from this bar's values.
      open.takeProfit = open.entryPrice + takeProfitMult * atrPrev;
      open.stopLoss = open.entryPrice - stopLossMult * atrPrev;
    }
    const dipPrev = i > 0 ? lowest(i - 1) : NaN; // Dip[1]
    if (!Number.isNaN(dipPrev) && c.close < dipPrev && !open) pendingEntry = true;
    if (open) {
      // strategy.exit with na stop/limit is a no-op on TradingView.
      exitLive = Number.isFinite(open.takeProfit) && Number.isFinite(open.stopLoss);
    }
  }
  return { trades, open };
}
