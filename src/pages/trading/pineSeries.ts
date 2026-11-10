/**
 * Turns a normalised Pine plot into a lightweight-charts series. Shared by the
 * price-pane overlays and the lower oscillator panes.
 */
import {
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { PineHLine, PineLinePlot, PinePoint } from "../../pine/types.ts";

export type PineSeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

type Row = LineData<Time> | WhitespaceData<Time>;

/**
 * Series rows for `points`. With `allTimes`, every chart bar gets a row
 * (whitespace where the script has no value) so the series shares the chart's
 * logical index space — required for pane time-scale synchronisation.
 */
export function toSeriesRows(points: PinePoint[], allTimes?: number[]): Row[] {
  if (!allTimes) {
    return points.map((p) =>
      p.value === null
        ? { time: p.time as Time }
        : p.color
          ? { time: p.time as Time, value: p.value, color: p.color }
          : { time: p.time as Time, value: p.value },
    );
  }
  const byTime = new Map<number, PinePoint>();
  for (const p of points) byTime.set(p.time, p);
  return allTimes.map((t) => {
    const p = byTime.get(t);
    if (!p || p.value === null) return { time: t as Time };
    return p.color ? { time: t as Time, value: p.value, color: p.color } : { time: t as Time, value: p.value };
  });
}

export function addPinePlotSeries(
  chart: IChartApi,
  plot: PineLinePlot,
  opts: { priceScaleId: string; allTimes?: number[]; crosshairMarker?: boolean },
): PineSeries {
  const rows = toSeriesRows(plot.points, opts.allTimes);
  // No `title`: lightweight-charts prints it on the price axis even with the
  // last value hidden, and the legends already name every plot.
  const common = {
    priceScaleId: opts.priceScaleId,
    lastValueVisible: false,
    priceLineVisible: false,
  };
  const width = Math.max(1, Math.min(4, Math.round(plot.lineWidth))) as 1 | 2 | 3 | 4;
  if (plot.style === "area" || plot.style === "histogram" || plot.style === "columns") {
    // Pine's area/histogram styles fill from zero to the value; a histogram
    // with per-bar colour reproduces the conditional colouring scripts use.
    const s = chart.addHistogramSeries({ ...common, color: plot.color, base: 0 });
    s.setData(rows);
    return s;
  }
  const dotted = plot.style === "cross" || plot.style === "circles";
  const s = chart.addLineSeries({
    ...common,
    color: plot.color,
    lineWidth: width,
    lineType: plot.style === "stepline" ? LineType.WithSteps : LineType.Simple,
    lineVisible: !dotted,
    pointMarkersVisible: dotted,
    pointMarkersRadius: dotted ? 2 : undefined,
    crosshairMarkerVisible: opts.crosshairMarker ?? false,
  });
  s.setData(rows);
  return s;
}

export function addPineHLineSeries(
  chart: IChartApi,
  hline: PineHLine,
  allTimes: number[],
  priceScaleId: string,
): ISeriesApi<"Line"> {
  const s = chart.addLineSeries({
    priceScaleId,
    color: hline.color,
    lineWidth: 1,
    lineStyle: hline.style === "dashed" ? LineStyle.Dashed : hline.style === "dotted" ? LineStyle.Dotted : LineStyle.Solid,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  s.setData(allTimes.map((t) => ({ time: t as Time, value: hline.value })));
  return s;
}

export function removeSeriesSafely(chart: IChartApi | null, series: Iterable<ISeriesApi<"Line"> | ISeriesApi<"Histogram">>): void {
  if (!chart) return;
  for (const s of series) {
    try {
      chart.removeSeries(s);
    } catch {
      /* chart already disposed */
    }
  }
}
