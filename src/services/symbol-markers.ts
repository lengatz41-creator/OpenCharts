/**
 * Per-symbol chart annotations supplied by an adapter (e.g. "BUY", "SELL 75%",
 * "EXIT +8%"). The chart draws them as series markers, bucketed to the active
 * timeframe. Times are unix seconds.
 */
export interface SymbolMarker {
  time: number;
  kind: string;
  text: string;
}

const store = new Map<string, SymbolMarker[]>();
const listeners = new Set<() => void>();
let version = 0;

export function setSymbolMarkers(symbol: string, markers: SymbolMarker[]): void {
  store.set(symbol, markers);
  version += 1;
  for (const l of [...listeners]) l();
}

export function getSymbolMarkers(symbol: string): SymbolMarker[] {
  return store.get(symbol) ?? [];
}

export function getSymbolMarkersVersion(): number {
  return version;
}

export function subscribeSymbolMarkers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
