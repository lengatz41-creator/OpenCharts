import { useEffect, useState } from "react";
import { readCsvDataset } from "../../adapter/csv-historical.ts";

export type ChartTradeEvent = {
  id: string;
  type: "entry" | "exit" | "violation";
  timestamp: string;
  symbolName: string | null;
  side: string | null;
  price: number | null;
  pnl: number | null;
  ruleCode?: string;
};

export function useCsvEvents(symbol: string): ChartTradeEvent[] {
  const [loaded, setLoaded] = useState<{ symbol: string; events: ChartTradeEvent[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!symbol.startsWith("CSV_")) return;
    void readCsvDataset(symbol).then((data) => {
      if (cancelled) return;
      const events = data.events.map((row, i): ChartTradeEvent => {
        const lower = row.event.toLowerCase();
        return {
          id: `${symbol}:${row.time}:${i}`,
          type: lower === "entry" ? "entry" : lower === "partial_sell" ? "violation" : "exit",
          timestamp: new Date(row.time * 1000).toISOString(),
          symbolName: symbol,
          side: lower === "entry" ? "BUY" : null,
          price: null,
          pnl: null,
          ruleCode: row.event,
        };
      });
      setLoaded({ symbol, events });
    }).catch((err: unknown) => console.error("Error loading CSV markers", err));
    return () => { cancelled = true; };
  }, [symbol]);
  return loaded?.symbol === symbol ? loaded.events : [];
}
