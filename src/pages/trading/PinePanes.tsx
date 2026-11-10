import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { openPineSettings } from "../../pine/params-store.ts";
import type { Timeframe } from "./constants.ts";
import { addPineHLineSeries, addPinePlotSeries, removeSeriesSafely, type PineSeries } from "./pineSeries.ts";
import type { PineScriptState } from "./usePineScripts.ts";

export interface PaneColors {
  background: string;
  text: string;
  grid: string;
  crosshair: string;
}

export interface PinePanesProps {
  mainChartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  chartEpoch: number;
  chartData: CandlestickData<Time>[];
  panes: PineScriptState[];
  colors: PaneColors;
  timeframe: Timeframe;
}

/** The minimum width the main chart's price axis is configured with. */
const MAIN_AXIS_MIN_WIDTH = 80;

/**
 * True lower panels for oscillator scripts: one lightweight-charts instance
 * per script, stacked under the price chart and kept in lock-step with it
 * (visible range both ways, crosshair both ways, price-axis width).
 */
export function PinePanes({ mainChartRef, mainSeriesRef, chartEpoch, chartData, panes, colors, timeframe }: PinePanesProps) {
  if (panes.length === 0) return null;
  return (
    <div className="flex w-full flex-col border-t border-border" style={{ height: `min(${panes.length * 150}px, 45%)` }}>
      {panes.map((state) => (
        <PinePane
          key={state.spec.id}
          mainChartRef={mainChartRef}
          mainSeriesRef={mainSeriesRef}
          chartEpoch={chartEpoch}
          chartData={chartData}
          state={state}
          colors={colors}
          timeframe={timeframe}
        />
      ))}
    </div>
  );
}

function PinePane({
  mainChartRef,
  mainSeriesRef,
  chartEpoch,
  chartData,
  state,
  colors,
  timeframe,
}: {
  mainChartRef: React.RefObject<IChartApi | null>;
  mainSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  chartEpoch: number;
  chartData: CandlestickData<Time>[];
  state: PineScriptState;
  colors: PaneColors;
  timeframe: Timeframe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<PineSeries[]>([]);
  const [paneEpoch, setPaneEpoch] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const result = state.result;

  // ── Create the pane chart and bind it to the main chart ───────────────────
  useEffect(() => {
    const container = containerRef.current;
    const main = mainChartRef.current;
    if (!container || !main) return;
    const pane = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 10,
        // The main chart carries the library's attribution; one per pane is noise.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed, labelVisible: false },
        horzLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#363a45" },
      },
      rightPriceScale: {
        borderColor: colors.grid,
        scaleMargins: { top: 0.12, bottom: 0.08 },
        minimumWidth: MAIN_AXIS_MIN_WIDTH,
        borderVisible: true,
      },
      timeScale: {
        visible: false,
        rightOffset: timeframe === "1m" ? 10 : 6,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      watermark: { visible: false },
      width: container.clientWidth,
      height: container.clientHeight,
    });
    chartRef.current = pane;

    // Range-change notifications arrive on the next frame, so a plain
    // re-entrancy flag cannot stop echoes; compare ranges instead and never
    // push a range out of a pane that holds no data yet.
    const sameRange = (a: { from: number; to: number } | null, b: { from: number; to: number } | null) =>
      !!a && !!b && Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;
    const alignAxis = () => {
      const w = Math.max(main.priceScale("right").width(), pane.priceScale("right").width(), MAIN_AXIS_MIN_WIDTH);
      pane.applyOptions({ rightPriceScale: { minimumWidth: w } });
      main.applyOptions({ rightPriceScale: { minimumWidth: w } });
    };
    const fromMain = (range: { from: number; to: number } | null) => {
      if (!range || seriesRef.current.length === 0) return;
      if (!sameRange(range, pane.timeScale().getVisibleLogicalRange())) pane.timeScale().setVisibleLogicalRange(range);
      alignAxis();
    };
    const fromPane = (range: { from: number; to: number } | null) => {
      if (!range || seriesRef.current.length === 0) return;
      if (!sameRange(range, main.timeScale().getVisibleLogicalRange())) main.timeScale().setVisibleLogicalRange(range);
    };
    main.timeScale().subscribeVisibleLogicalRangeChange(fromMain);
    pane.timeScale().subscribeVisibleLogicalRangeChange(fromPane);

    let syncing = false;
    const mainCross = (param: { time?: Time }) => {
      if (syncing) return;
      syncing = true;
      const s = seriesRef.current[0];
      const t = param.time as number | undefined;
      if (t !== undefined && s) {
        const value = valueAtRef.current.get(t);
        if (value !== undefined) pane.setCrosshairPosition(value, t as Time, s);
        else pane.clearCrosshairPosition();
        setHover(t);
      } else {
        pane.clearCrosshairPosition();
        setHover(null);
      }
      syncing = false;
    };
    const paneCross = (param: { time?: Time }) => {
      if (syncing) return;
      syncing = true;
      const t = param.time as number | undefined;
      const candles = mainSeriesRef.current;
      const close = t === undefined ? undefined : closeAtRef.current.get(t);
      if (t !== undefined && candles && close !== undefined) main.setCrosshairPosition(close, t as Time, candles);
      else main.clearCrosshairPosition();
      setHover(t ?? null);
      syncing = false;
    };
    main.subscribeCrosshairMove(mainCross);
    pane.subscribeCrosshairMove(paneCross);

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) pane.applyOptions({ width: e.contentRect.width, height: e.contentRect.height });
      alignAxis();
    });
    ro.observe(container);
    setPaneEpoch((e) => e + 1);

    return () => {
      ro.disconnect();
      main.timeScale().unsubscribeVisibleLogicalRangeChange(fromMain);
      main.unsubscribeCrosshairMove(mainCross);
      try {
        main.applyOptions({ rightPriceScale: { minimumWidth: MAIN_AXIS_MIN_WIDTH } });
      } catch {
        /* main chart disposed */
      }
      seriesRef.current = [];
      pane.remove();
      chartRef.current = null;
    };
    // mainChartRef/mainSeriesRef are stable refs; chartEpoch re-binds after the main chart is recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, colors, timeframe]);

  // Lookups for crosshair anchoring: first plot of the script, and candle closes.
  const valueAtRef = useRef(new Map<number, number>());
  const closeAtRef = useRef(new Map<number, number>());

  // ── Series: rebuilt when the result or the chart window changes ───────────
  useEffect(() => {
    const pane = chartRef.current;
    const main = mainChartRef.current;
    if (!pane || !main) return;
    removeSeriesSafely(pane, seriesRef.current);
    seriesRef.current = [];
    valueAtRef.current = new Map();
    closeAtRef.current = new Map(chartData.map((c) => [c.time as number, c.close]));
    if (!result || chartData.length === 0) return;
    const allTimes = chartData.map((c) => c.time as number);
    const added: PineSeries[] = [];
    for (const plot of result.lines) {
      if (plot.overlay) continue;
      added.push(addPinePlotSeries(pane, plot, { priceScaleId: "right", allTimes, crosshairMarker: true }));
    }
    for (const h of result.hlines) added.push(addPineHLineSeries(pane, h, allTimes, "right"));
    seriesRef.current = added;
    const first = result.lines.find((l) => !l.overlay);
    if (first) for (const p of first.points) if (p.value !== null) valueAtRef.current.set(p.time, p.value);
    const range = main.timeScale().getVisibleLogicalRange();
    if (range) pane.timeScale().setVisibleLogicalRange(range);
    // mainChartRef is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneEpoch, chartData, result]);

  const legendTime = hover ?? result?.meta.lastTime ?? null;
  return (
    <div className="relative min-h-0 flex-1 border-b border-border last:border-b-0">
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap items-center gap-x-2 text-[10px] font-mono leading-tight">
        <button
          type="button"
          onClick={() => openPineSettings(state.spec.id)}
          className="pointer-events-auto font-semibold text-foreground hover:text-primary"
          title="Script settings"
        >
          {state.spec.shortLabel}
        </button>
        {state.status === "running" && <span className="text-muted-foreground">computing…</span>}
        {state.status === "error" && <span className="text-[#f6465d]">{state.error}</span>}
        {result &&
          legendTime !== null &&
          result.lines
            .filter((l) => !l.overlay)
            .map((l) => {
              const p = l.points.find((x) => x.time === legendTime);
              return (
                <span key={l.title} style={{ color: p?.color ?? l.color }} className={cn(state.stale && "opacity-60")}>
                  {l.title.length > 18 ? `${l.title.slice(0, 18)}…` : l.title} {p?.value === null || p?.value === undefined ? "na" : formatValue(p.value)}
                </span>
              );
            })}
        {result && state.spec.usesVolume && (
          <span className="text-muted-foreground">
            vol: {result.meta.volumeMode === "quote" ? "quote (USD)" : "≈ base"}
          </span>
        )}
      </div>
    </div>
  );
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}
