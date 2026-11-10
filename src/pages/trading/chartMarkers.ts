/**
 * The one place chart markers are assembled.
 *
 * Replay trade events, adapter symbol markers, imported CSV trade events, Pine
 * signal shapes, Pine labels and strategy fills all become `SeriesMarker`s
 * here and are merged into a single, time-sorted list, so no two effects can
 * overwrite each other's `setMarkers()` call. Each marker carries an `id`
 * that names its source, so a reader can always tell a CSV `ENTRY` from a
 * script's `BUY` from a broker fill.
 */
import type { SeriesMarker, SeriesMarkerPosition, SeriesMarkerShape, Time } from "lightweight-charts";
import type { PineDisplayOptions } from "../../pine/params-store.ts";
import type { PineLabel, PineShape, PineStrategyResult } from "../../pine/types.ts";
import type { Timeframe } from "./constants.ts";
import type { ChartTradeEvent } from "./useCsvEvents.ts";
import type { PineStates } from "./usePineScripts.ts";
import { getCandleBucketTime } from "./utils.ts";

export const MARKER_COLORS = {
  csvEntry: "#2196f3",
  csvPartial: "#ff9800",
  csvExit: "#9e9e9e",
  fillEntry: "#b388ff",
  fillExit: "#7c4dff",
} as const;

/** Imported CSV trade events: real (simulated-ledger) events, never signals. */
export function buildCsvEventMarker(ev: ChartTradeEvent, timeframe: Timeframe): SeriesMarker<Time> {
  const time = getCandleBucketTime(Date.parse(ev.timestamp), timeframe) as Time;
  const text = ev.ruleCode ?? ev.type;
  const id = `csv:${ev.id}`;
  if (ev.type === "entry") {
    return { id, time, position: "belowBar", shape: "arrowUp", color: MARKER_COLORS.csvEntry, text };
  }
  if (ev.type === "violation") {
    return { id, time, position: "aboveBar", shape: "arrowDown", color: MARKER_COLORS.csvPartial, text };
  }
  return { id, time, position: "aboveBar", shape: "circle", color: MARKER_COLORS.csvExit, text };
}

function shapeOf(kind: PineShape["shape"]): SeriesMarkerShape {
  switch (kind) {
    case "triangleup":
    case "labelup":
    case "arrowup":
      return "arrowUp";
    case "triangledown":
    case "labeldown":
    case "arrowdown":
      return "arrowDown";
    case "circle":
      return "circle";
    default:
      return "square";
  }
}

function positionOf(location: PineShape["location"]): SeriesMarkerPosition {
  if (location === "belowbar") return "belowBar";
  if (location === "abovebar") return "aboveBar";
  return "inBar";
}

/** `plotshape` hits of one script. Text is the script's own, when it set one. */
export function buildPineShapeMarkers(scriptId: string, shapes: PineShape[]): SeriesMarker<Time>[] {
  return shapes.map((s) => ({
    id: `${scriptId}:shape:${s.title}:${s.time}`,
    time: s.time as Time,
    position: positionOf(s.location),
    shape: shapeOf(s.shape),
    color: s.color,
    text: s.text,
  }));
}

/** `label.new` objects, drawn as text markers at their bar. */
export function buildPineLabelMarkers(scriptId: string, labels: PineLabel[]): SeriesMarker<Time>[] {
  return labels.map((l) => ({
    id: `${scriptId}:label:${l.time}`,
    time: l.time as Time,
    position: l.style === "down" ? "aboveBar" : "belowBar",
    shape: l.style === "down" ? "arrowDown" : "arrowUp",
    color: l.color,
    text: l.text,
  }));
}

/**
 * Broker fills of a strategy. Only offered once the runtime's trades were
 * reproduced by the independent simulator; a signal is never a fill.
 */
export function buildStrategyFillMarkers(
  scriptId: string,
  strategy: PineStrategyResult,
  digits: number,
): SeriesMarker<Time>[] {
  if (!strategy.crossCheck.passed) return [];
  const out: SeriesMarker<Time>[] = [];
  const all = strategy.openTrade ? [...strategy.trades, strategy.openTrade] : strategy.trades;
  for (const t of all) {
    out.push({
      id: `${scriptId}:fill:${t.id}:entry`,
      time: t.entryTime as Time,
      position: "belowBar",
      shape: "arrowUp",
      color: MARKER_COLORS.fillEntry,
      text: `FILL ${t.entryId} @${t.entryPrice.toFixed(digits)}`,
    });
    if (t.exitTime !== null && t.exitPrice !== null) {
      const pnl = t.profit ?? 0;
      out.push({
        id: `${scriptId}:fill:${t.id}:exit`,
        time: t.exitTime as Time,
        position: "aboveBar",
        shape: "arrowDown",
        color: MARKER_COLORS.fillExit,
        text: `FILL ${t.exitId ?? "exit"} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(digits)}`,
      });
    }
  }
  return out;
}

/** Every marker the active Pine scripts contribute. */
export function buildPineMarkers(
  states: PineStates,
  display: (scriptId: string) => PineDisplayOptions,
  digits: number,
): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  for (const [id, state] of Object.entries(states)) {
    const res = state.result;
    if (!res) continue;
    out.push(...buildPineShapeMarkers(id, res.shapes));
    out.push(...buildPineLabelMarkers(id, res.labels));
    if (res.strategy && display(id).showFills) out.push(...buildStrategyFillMarkers(id, res.strategy, digits));
  }
  return out;
}

/** Merge marker lists from every source into the sorted list the series needs. */
export function composeChartMarkers(...groups: SeriesMarker<Time>[][]): SeriesMarker<Time>[] {
  const all: Array<{ m: SeriesMarker<Time>; order: number }> = [];
  let order = 0;
  for (const g of groups) for (const m of g) all.push({ m, order: order++ });
  // Stable sort: ascending time, then insertion order so same-bar markers keep
  // their source grouping (lightweight-charts requires ascending times).
  all.sort((a, b) => (a.m.time as number) - (b.m.time as number) || a.order - b.order);
  return all.map((x) => x.m);
}
