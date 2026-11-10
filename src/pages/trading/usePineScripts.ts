import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CandlestickData, HistogramData, Time } from "lightweight-charts";
import type { IndicatorType } from "../../lib/indicators.ts";
import { pineEngine } from "../../pine/engine.ts";
import { getPineParams, getPineStoreVersion, getPineVolumeMode, subscribePineStore } from "../../pine/params-store.ts";
import { getPineScript, isPineScriptId, type PineScriptSpec } from "../../pine/registry.ts";
import type { PineCandle, PineRunSuccess } from "../../pine/types.ts";
import { TF_INTERVAL_MS, type Timeframe } from "./constants.ts";

export interface PineScriptState {
  spec: PineScriptSpec;
  status: "running" | "done" | "error";
  /** Last successful result; kept (marked stale) while a re-run is in flight. */
  result?: PineRunSuccess;
  stale: boolean;
  error?: string;
  stage?: string;
}

export type PineStates = Record<string, PineScriptState>;

const EMPTY: PineStates = {};
const DEBOUNCE_MS = 120;

/**
 * Evaluate the active Pine scripts against the loaded chart window.
 *
 * Execution is separate from rendering: this hook only owns "which script,
 * which data, which params → which result". Results come from `pineEngine`
 * (worker + cache), so toggling a script back on, or switching away and back,
 * is instant when the window is unchanged.
 */
export function usePineScripts(
  chartData: CandlestickData<Time>[],
  volumeData: HistogramData<Time>[],
  symbol: string,
  timeframe: Timeframe,
  activeIndicators: IndicatorType[],
): PineStates {
  const activeIds = useMemo(
    () => activeIndicators.filter((id) => isPineScriptId(id)),
    [activeIndicators],
  );
  const activeKey = activeIds.join(",");
  const storeVersion = useSyncExternalStore(subscribePineStore, getPineStoreVersion, getPineStoreVersion);

  const hasActive = activeIds.length > 0;
  const candles = useMemo<PineCandle[]>(() => {
    if (chartData.length === 0 || !hasActive) return [];
    return chartData.map((c, i) => ({
      time: c.time as number,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: volumeData[i]?.value ?? 0,
    }));
  }, [chartData, volumeData, hasActive]);

  const [states, setStates] = useState<PineStates>(EMPTY);

  useEffect(() => {
    if (activeIds.length === 0 || candles.length === 0) {
      setStates(EMPTY);
      return;
    }
    let cancelled = false;
    const intervalSec = (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000;
    const volumeMode = getPineVolumeMode(symbol);

    // Drop scripts that were toggled off; mark the rest as re-running.
    setStates((prev) => {
      const next: PineStates = {};
      for (const id of activeIds) {
        const spec = getPineScript(id);
        if (!spec) continue;
        const old = prev[id];
        next[id] = old ? { ...old, status: "running", stale: old.result !== undefined } : { spec, status: "running", stale: false };
      }
      return next;
    });

    const timer = window.setTimeout(() => {
      for (const id of activeIds) {
        const spec = getPineScript(id);
        if (!spec) continue;
        pineEngine
          .run({
            scriptId: id,
            symbol,
            timeframe,
            intervalSec,
            candles,
            params: getPineParams(id),
            volumeMode,
          })
          .then((res) => {
            if (cancelled) return;
            setStates((prev) => {
              const current = prev[id];
              if (!current) return prev; // toggled off meanwhile
              const next: PineScriptState = res.ok
                ? { spec, status: "done", result: res, stale: false }
                : { spec, status: "error", error: res.error, stage: res.stage, stale: false };
              return { ...prev, [id]: next };
            });
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setStates((prev) =>
              prev[id]
                ? { ...prev, [id]: { spec, status: "error", error: err instanceof Error ? err.message : String(err), stale: false } }
                : prev,
            );
          });
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // activeKey is the stable identity of activeIds; storeVersion re-runs on param edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, candles, symbol, timeframe, storeVersion]);

  return states;
}
