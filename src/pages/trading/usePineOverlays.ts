import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { getPineDisplay, getPineStoreVersion, subscribePineStore } from "../../pine/params-store.ts";
import { addPinePlotSeries, removeSeriesSafely, type PineSeries } from "./pineSeries.ts";
import type { PineStates } from "./usePineScripts.ts";

const BG_SCALE_ID = "pine-bg";

/**
 * Draw the price-pane output of overlay scripts on the main chart: plot lines
 * on the candle price scale, `line.new` segments, `bgcolor` bands and
 * `barcolor` candle painting. Everything it adds is removed when the script
 * is toggled off, the data window changes or the chart is recreated.
 */
export function usePineOverlays(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartEpoch: number,
  chartData: CandlestickData<Time>[],
  states: PineStates,
): void {
  const seriesRef = useRef<PineSeries[]>([]);
  const paintedRef = useRef(false);
  const storeVersion = useSyncExternalStore(subscribePineStore, getPineStoreVersion, getPineStoreVersion);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleSeriesRef.current;
    if (!chart || !candles) return;

    const cleanup = () => {
      removeSeriesSafely(chartRef.current, seriesRef.current);
      seriesRef.current = [];
      if (paintedRef.current && candleSeriesRef.current) {
        try {
          candleSeriesRef.current.setData(chartData);
        } catch {
          /* chart disposed */
        }
        paintedRef.current = false;
      }
    };
    cleanup();
    if (chartData.length === 0) return;

    const allTimes = chartData.map((c) => c.time as number);
    const added: PineSeries[] = [];
    let barColors: Map<number, string> | null = null;
    const bgRows: { time: Time; value: number; color: string }[] = [];

    for (const [id, state] of Object.entries(states)) {
      const res = state.result;
      if (!res || state.spec.pane !== "overlay") continue;
      const display = getPineDisplay(id);

      for (const plot of res.lines) {
        if (!plot.overlay) continue;
        if (plot.points.every((p) => p.value === null)) continue; // e.g. EMAs hidden by input
        added.push(addPinePlotSeries(chart, plot, { priceScaleId: "right" }));
      }

      // One series per `line.new` segment: lightweight-charts 4 joins a line
      // series across whitespace, so segments cannot share a series without
      // being connected. The runtime keeps at most max_lines_count (50) alive.
      for (const l of res.drawingLines) {
        const rows: Array<{ time: Time; value: number }> = [{ time: l.fromTime as Time, value: l.fromPrice }];
        if (l.toTime > l.fromTime) rows.push({ time: l.toTime as Time, value: l.toPrice });
        const s = chart.addLineSeries({
          priceScaleId: "right",
          color: l.color,
          lineWidth: Math.max(1, Math.min(4, Math.round(l.width))) as 1 | 2 | 3 | 4,
          lineStyle: l.style === "dashed" ? LineStyle.Dashed : l.style === "dotted" ? LineStyle.Dotted : LineStyle.Solid,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(rows);
        added.push(s);
      }

      if (display.showBackground) {
        for (const b of res.bgcolors) bgRows.push({ time: b.time as Time, value: 1, color: b.color });
      }
      if (display.paintBars && res.barcolors.length > 0) {
        barColors = new Map(res.barcolors.map((b) => [b.time, b.color]));
      }
    }

    if (bgRows.length > 0) {
      bgRows.sort((a, b) => (a.time as number) - (b.time as number));
      // Full-height bars on a hidden scale emulate Pine's bgcolor() bands.
      const bg = chart.addHistogramSeries({
        priceScaleId: BG_SCALE_ID,
        base: 0,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale(BG_SCALE_ID).applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } });
      const byTime = new Map(bgRows.map((r) => [r.time as number, r]));
      bg.setData(allTimes.map((t) => byTime.get(t) ?? { time: t as Time }));
      added.push(bg);
    }

    if (barColors) {
      const map = barColors;
      candles.setData(
        chartData.map((c) => {
          const color = map.get(c.time as number);
          return color ? { ...c, color, wickColor: color, borderColor: color } : c;
        }),
      );
      paintedRef.current = true;
    }
    seriesRef.current = added;
    return cleanup;
    // chartRef/candleSeriesRef are stable refs; chartEpoch re-binds after recreation,
    // storeVersion re-applies display toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, chartData, states, storeVersion]);
}
