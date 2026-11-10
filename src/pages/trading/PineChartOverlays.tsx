import { Settings2, TableProperties, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "../../lib/utils.ts";
import {
  getPineDisplay,
  getPineStoreVersion,
  openPineSettings,
  setPineDisplay,
  subscribePineStore,
} from "../../pine/params-store.ts";
import type { PineStrategyResult, PineTable } from "../../pine/types.ts";
import type { PineScriptState, PineStates } from "./usePineScripts.ts";

// ── Legend: one row per active script, under the OHLC legend ─────────────────

function statusText(state: PineScriptState): string {
  if (state.status === "error") return `${state.stage ?? "error"}: ${state.error ?? "failed"}`;
  const r = state.result;
  if (!r) return "computing…";
  const parts: string[] = [`${r.meta.bars} bars`];
  if (r.shapes.length) parts.push(`${r.shapes.length} signals`);
  if (r.strategy) {
    parts.push(`${r.strategy.trades.length} trades`);
    if (r.strategy.openTradeStuck) parts.push("open position has no exit levels");
    else if (r.strategy.openTrade) parts.push("1 open");
  }
  if (r.meta.gaps) parts.push(`${r.meta.gaps} gaps`);
  if (state.spec.usesVolume) parts.push(r.meta.volumeMode === "quote" ? "quote vol" : "≈base vol");
  if (state.status === "running") parts.push("recomputing…");
  return parts.join(" · ");
}

export function PineLegend({ states }: { states: PineStates }) {
  useSyncExternalStore(subscribePineStore, getPineStoreVersion, getPineStoreVersion);
  const rows = Object.values(states);
  if (rows.length === 0) return null;
  return (
    <div className="absolute left-3 top-[52px] z-10 flex flex-col gap-0.5 text-[10px] font-mono leading-tight">
      {rows.map((state) => {
        const display = getPineDisplay(state.spec.id);
        const warn = state.result?.warnings ?? [];
        return (
          <div key={state.spec.id} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: state.spec.color }} />
            <button
              type="button"
              onClick={() => openPineSettings(state.spec.id)}
              className="font-semibold text-foreground hover:text-primary"
              title={state.spec.label}
            >
              {state.spec.shortLabel}
            </button>
            <span className={cn("text-muted-foreground", state.status === "error" && "text-[#f6465d]")}>{statusText(state)}</span>
            {warn.length > 0 && (
              <span className="text-[#f0b90b]" title={warn.join("\n")}>
                {warn.length} warning{warn.length > 1 ? "s" : ""}
              </span>
            )}
            {state.result?.strategy && (
              <button
                type="button"
                onClick={() => setPineDisplay(state.spec.id, { showLedger: !display.showLedger })}
                className={cn("flex items-center gap-0.5 rounded border border-border px-1 py-px", display.showLedger ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                title="Strategy ledger"
              >
                <TableProperties className="h-2.5 w-2.5" /> ledger
              </button>
            )}
            <button
              type="button"
              onClick={() => openPineSettings(state.spec.id)}
              className="text-muted-foreground hover:text-foreground"
              title="Script settings"
            >
              <Settings2 className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Tables (table.new): rendered as HTML at the script's position ────────────

const TABLE_POSITION: Record<string, string> = {
  top_left: "left-3 top-20",
  top_center: "left-1/2 top-20 -translate-x-1/2",
  top_right: "right-24 top-3",
  middle_left: "left-3 top-1/2 -translate-y-1/2",
  middle_center: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
  middle_right: "right-24 top-1/2 -translate-y-1/2",
  bottom_left: "left-3 bottom-8",
  bottom_center: "left-1/2 bottom-8 -translate-x-1/2",
  bottom_right: "right-24 bottom-8",
};

function TableView({ table, label }: { table: PineTable; label: string }) {
  const rows = table.rows.filter((r) => r.some((c) => c.text || c.bgColor));
  if (rows.length === 0) return null;
  const columns = rows[0]!.length;
  return (
    <div
      className={cn("pointer-events-none absolute z-10 rounded border border-border/60 bg-card/80 p-1 shadow", TABLE_POSITION[table.position] ?? TABLE_POSITION.bottom_center)}
      title={label}
    >
      <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${columns}, minmax(4px, auto))` }}>
        {rows.flatMap((row, r) =>
          row.map((cell, c) => (
            <div
              key={`${r}-${c}`}
              className="flex h-4 items-center justify-center whitespace-nowrap px-0.5 text-[9px] font-mono leading-none"
              style={{ backgroundColor: cell.bgColor ?? undefined, color: cell.textColor ?? undefined, minWidth: cell.text ? undefined : 4 }}
            >
              {cell.text}
            </div>
          )),
        )}
      </div>
    </div>
  );
}

export function PineTableOverlay({ states }: { states: PineStates }) {
  const items: Array<{ key: string; table: PineTable; label: string }> = [];
  for (const state of Object.values(states)) {
    state.result?.tables.forEach((table, i) => items.push({ key: `${state.spec.id}:${i}`, table, label: state.spec.label }));
  }
  if (items.length === 0) return null;
  return (
    <>
      {items.map((it) => (
        <TableView key={it.key} table={it.table} label={it.label} />
      ))}
    </>
  );
}

// ── Strategy ledger ──────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function LedgerPanel({ state, strategy, digits }: { state: PineScriptState; strategy: PineStrategyResult; digits: number }) {
  const total = strategy.trades.length;
  const winRate = total ? (strategy.winTrades / total) * 100 : 0;
  const check = strategy.crossCheck;
  return (
    <div className="absolute right-24 top-3 z-20 flex max-h-[70%] w-[340px] flex-col overflow-hidden rounded-lg border border-border bg-card/95 text-[11px] shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-foreground">{state.spec.shortLabel} · backtest ledger</span>
          <span className="text-[10px] text-muted-foreground">PineTS broker emulation, not account trades</span>
        </div>
        <button type="button" onClick={() => setPineDisplay(state.spec.id, { showLedger: false })} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className={cn("px-3 py-1.5 text-[10px]", check.passed ? "bg-[#0ecb81]/10 text-[#0ecb81]" : "bg-[#f6465d]/10 text-[#f6465d]")}>
        {check.passed
          ? `Cross-check passed: ${check.runtimeTrades} runtime trades reproduced by the independent simulator.`
          : `Cross-check FAILED (${check.runtimeTrades} runtime vs ${check.simulatorTrades} simulator trades). Fill markers are withheld.`}
        {!check.passed && check.mismatches.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {check.mismatches.slice(0, 4).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>
      {strategy.openTradeStuck && strategy.openTrade && (
        <div className="border-b border-border bg-[#f0b90b]/10 px-3 py-1.5 text-[10px] text-[#f0b90b]">
          The position opened {fmtTime(strategy.openTrade.entryTime)} before ATR({"ATR Length"}) had a value, so the script's exit has na stop/limit and never fires — exactly as the Pine source behaves when its first dip falls inside the ATR warm-up. Results depend on where the loaded window starts; load more history or move the window.
        </div>
      )}
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 border-b border-border px-3 py-2 font-mono">
        <Stat label="trades" value={String(total)} />
        <Stat label="win rate" value={`${winRate.toFixed(1)}%`} />
        <Stat label="net" value={strategy.netProfit.toFixed(digits)} tone={strategy.netProfit >= 0 ? "up" : "down"} />
        <Stat label="gross +" value={strategy.grossProfit.toFixed(digits)} />
        <Stat label="gross −" value={strategy.grossLoss.toFixed(digits)} />
        <Stat label="max DD" value={strategy.maxDrawdown.toFixed(digits)} />
      </div>
      <details className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer">Fill assumptions</summary>
        <ul className="mt-1 list-disc pl-4">
          {strategy.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full font-mono text-[10px]">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-normal">entry</th>
              <th className="px-2 py-1 text-right font-normal">@</th>
              <th className="px-2 py-1 text-left font-normal">exit</th>
              <th className="px-2 py-1 text-right font-normal">@</th>
              <th className="px-2 py-1 text-right font-normal">pnl</th>
            </tr>
          </thead>
          <tbody>
            {[...strategy.trades].reverse().map((t) => (
              <tr key={t.id} className="border-t border-border/50">
                <td className="px-2 py-0.5">{fmtTime(t.entryTime)}</td>
                <td className="px-2 py-0.5 text-right">{t.entryPrice.toFixed(digits)}</td>
                <td className="px-2 py-0.5">{t.exitTime === null ? "open" : fmtTime(t.exitTime)}</td>
                <td className="px-2 py-0.5 text-right">{t.exitPrice === null ? "—" : t.exitPrice.toFixed(digits)}</td>
                <td className={cn("px-2 py-0.5 text-right", (t.profit ?? 0) >= 0 ? "text-[#0ecb81]" : "text-[#f6465d]")}>
                  {t.profit === null ? "—" : t.profit.toFixed(digits)}
                </td>
              </tr>
            ))}
            {strategy.openTrade && (
              <tr className="border-t border-border/50 text-muted-foreground">
                <td className="px-2 py-0.5">{fmtTime(strategy.openTrade.entryTime)}</td>
                <td className="px-2 py-0.5 text-right">{strategy.openTrade.entryPrice.toFixed(digits)}</td>
                <td className="px-2 py-0.5" colSpan={3}>
                  open position
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] text-muted-foreground">{label}</span>
      <span className={cn("text-[11px]", tone === "up" && "text-[#0ecb81]", tone === "down" && "text-[#f6465d]")}>{value}</span>
    </div>
  );
}

export function PineStrategyLedgers({ states, digits }: { states: PineStates; digits: number }) {
  useSyncExternalStore(subscribePineStore, getPineStoreVersion, getPineStoreVersion);
  const open = Object.values(states).filter((s) => s.result?.strategy && getPineDisplay(s.spec.id).showLedger);
  return (
    <>
      {open.map((s) => (
        <LedgerPanel key={s.spec.id} state={s} strategy={s.result!.strategy!} digits={digits} />
      ))}
    </>
  );
}
