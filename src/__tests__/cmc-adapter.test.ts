import { describe, expect, it } from "vitest";
import { aggregate } from "../../examples/cmc-tokens/cmc-adapter.ts";
import { getMinMove, getPipDigits } from "../pages/trading/utils.ts";

describe("cmc adapter helpers", () => {
  it("aggregates 1m bars into the chart's buckets", () => {
    const s = { t: [0, 60, 120, 300, 360], o: [1, 2, 3, 4, 5], h: [1, 4, 3, 6, 5], l: [1, 1, 0.5, 4, 5],
      c: [2, 3, 2.5, 5, 5.5], v: [1, 1, 1, 1, 1], m: [] as [number, string, string][] };
    expect(aggregate(s, "5m")).toEqual([
      { time: 0, open: 1, high: 4, low: 0.5, close: 2.5, volume: 3 },
      { time: 300, open: 4, high: 6, low: 4, close: 5.5, volume: 2 },
    ]);
    expect(aggregate(s, "1m")).toHaveLength(5);
  });

  it("shows enough decimals for memecoin prices", () => {
    expect(getPipDigits({ tickSize: 1e-17 }, "X")).toBe(17);
    expect(getPipDigits({ tickSize: 1.5e-9 }, "X")).toBe(10);
    expect(getPipDigits({ tickSize: 0.0001 }, "XRPUSD")).toBe(5);
    expect(getMinMove(17)).toBeCloseTo(1e-17, 25);
  });
});
