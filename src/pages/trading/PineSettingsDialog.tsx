import { GripVertical, RotateCcw, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useDragOffset } from "../../hooks/useDragOffset.ts";
import { cn } from "../../lib/utils.ts";
import { pineEngine } from "../../pine/engine.ts";
import {
  getPineDisplay,
  getPineParams,
  getPineSettingsOpenFor,
  getPineStoreVersion,
  getPineVolumeMode,
  openPineSettings,
  setPineDisplay,
  setPineParams,
  setPineVolumeMode,
  subscribePineStore,
} from "../../pine/params-store.ts";
import { getPineScript, type PineScriptSpec } from "../../pine/registry.ts";
import type { PineInputMeta, PineParamValue, PineParams } from "../../pine/types.ts";
import type { PineStates } from "./usePineScripts.ts";

/**
 * Parameter editor for one Pine script. Inputs come from the script's own
 * `input.*` declarations (titles, defaults, ranges, options) so nothing is
 * hard-coded here; values persist per script and apply live.
 */
export function PineSettingsDialog({ symbol, states }: { symbol: string; states: PineStates }) {
  useSyncExternalStore(subscribePineStore, getPineStoreVersion, getPineStoreVersion);
  const scriptId = getPineSettingsOpenFor();
  const spec = scriptId ? getPineScript(scriptId) : undefined;
  if (!spec) return null;
  return <DialogBody key={spec.id} spec={spec} symbol={symbol} state={states[spec.id]} />;
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors", checked ? "bg-primary" : "bg-secondary")}
    >
      <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-[2px]")} />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-xs text-foreground">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function NumberField({ value, meta, onCommit }: { value: number; meta: PineInputMeta; onCommit: (v: number) => void }) {
  // Remounted by its parent (`key`) whenever the stored value changes.
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n === value) {
      setText(String(value));
      return;
    }
    let v = meta.type === "int" ? Math.round(n) : n;
    if (meta.minval !== undefined) v = Math.max(meta.minval, v);
    if (meta.maxval !== undefined) v = Math.min(meta.maxval, v);
    onCommit(v);
  };
  return (
    <input
      type="number"
      value={text}
      min={meta.minval}
      max={meta.maxval}
      step={meta.step ?? (meta.type === "int" ? 1 : "any")}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-24 rounded border border-border bg-background px-2 py-1 text-right text-xs font-mono text-foreground"
    />
  );
}

function InputControl({ meta, value, onChange }: { meta: PineInputMeta; value: PineParamValue; onChange: (v: PineParamValue) => void }) {
  if (meta.type === "bool") return <Switch checked={Boolean(value)} onChange={onChange} />;
  if (meta.options && meta.options.length > 0) {
    return (
      <select
        value={String(value)}
        onChange={(e) => {
          const picked = meta.options!.find((o) => String(o) === e.target.value);
          if (picked !== undefined) onChange(picked);
        }}
        className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        {meta.options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  }
  if (meta.type === "int" || meta.type === "float") {
    const n = typeof value === "number" ? value : Number(value);
    return <NumberField key={n} value={n} meta={meta} onCommit={onChange} />;
  }
  if (meta.type === "color") {
    return (
      <input
        type="color"
        value={typeof value === "string" && /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : "#888888"}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 cursor-pointer rounded-full border border-border bg-transparent p-0"
      />
    );
  }
  return (
    <input
      type="text"
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      className="w-32 rounded border border-border bg-background px-2 py-1 text-xs font-mono text-foreground"
    />
  );
}

function DialogBody({ spec, symbol, state }: { spec: PineScriptSpec; symbol: string; state?: PineStates[string] }) {
  const drag = useDragOffset();
  const [inputs, setInputs] = useState<PineInputMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"inputs" | "display" | "about">("inputs");
  useEffect(() => {
    let cancelled = false;
    pineEngine
      .describe(spec.id)
      .then((m) => {
        if (!cancelled) setInputs(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [spec.id]);

  const params = getPineParams(spec.id);
  const display = getPineDisplay(spec.id);
  const volumeMode = getPineVolumeMode(symbol);
  const close = () => {
    drag.reset();
    openPineSettings(null);
  };
  const update = (key: string, value: PineParamValue, defval: PineParamValue | null) => {
    const next: PineParams = { ...params };
    if (value === defval) delete next[key];
    else next[key] = value;
    setPineParams(spec.id, next);
  };
  const groups = new Map<string, PineInputMeta[]>();
  for (const m of inputs ?? []) {
    const g = m.group ?? "Inputs";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  const meta = state?.result?.meta;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="flex h-[460px] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        style={drag.style}
        onClick={(e) => e.stopPropagation()}
      >
        <div onPointerDown={drag.onPointerDown} className="flex cursor-grab select-none items-center justify-between border-b border-border px-3 py-2.5 active:cursor-grabbing">
          <div className="flex min-w-0 items-center gap-1.5">
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60" />
            <h2 className="truncate text-sm font-semibold text-foreground">{spec.label}</h2>
          </div>
          <button onClick={close} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-28 shrink-0 border-r border-border p-2">
            {(["inputs", "display", "about"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn("flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs capitalize transition-colors", tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
            {tab === "inputs" && (
              <>
                {loadError && <div className="text-xs text-[#f6465d]">{loadError}</div>}
                {!inputs && !loadError && <div className="text-xs text-muted-foreground">Loading inputs…</div>}
                {inputs && inputs.length === 0 && <div className="text-xs text-muted-foreground">This script declares no inputs.</div>}
                {[...groups.entries()].map(([group, items]) => (
                  <div key={group} className="mb-2">
                    <div className="mb-0.5 mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
                    {items.map((m) => {
                      const value = params[m.key] ?? m.defval ?? "";
                      return (
                        <Row key={m.key} label={m.title} hint={m.tooltip}>
                          <InputControl meta={m} value={value} onChange={(v) => update(m.key, v, m.defval)} />
                        </Row>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
            {tab === "display" && (
              <>
                {spec.usesVolume && (
                  <div className="mb-2 rounded border border-[#f0b90b]/40 bg-[#f0b90b]/10 p-2 text-[10px] text-muted-foreground">
                    This script uses <span className="text-foreground">volume</span>. Imported CSV volume is quote currency (USD/USDT), not base-token units as on TradingView, so volume-weighted values differ from the TradingView chart.
                    <div className="mt-1.5 flex items-center gap-3">
                      {(["quote", "approx-base"] as const).map((mode) => (
                        <label key={mode} className="flex cursor-pointer items-center gap-1 text-foreground">
                          <input type="radio" name="pine-volume-mode" checked={volumeMode === mode} onChange={() => setPineVolumeMode(symbol, mode)} />
                          {mode === "quote" ? "as-is (quote)" : "≈ base units (÷ OHLC4, estimate)"}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <Row label="Paint candles (barcolor)" hint="Apply the script's bar colours to the candles">
                  <Switch checked={display.paintBars} onChange={(v) => setPineDisplay(spec.id, { paintBars: v })} />
                </Row>
                <Row label="Background bands (bgcolor)">
                  <Switch checked={display.showBackground} onChange={(v) => setPineDisplay(spec.id, { showBackground: v })} />
                </Row>
                {spec.kind === "strategy" && (
                  <>
                    <Row label="Fill markers" hint="Broker-emulated entries/exits; only drawn when the cross-check passes">
                      <Switch checked={display.showFills} onChange={(v) => setPineDisplay(spec.id, { showFills: v })} />
                    </Row>
                    <Row label="Ledger panel">
                      <Switch checked={display.showLedger} onChange={(v) => setPineDisplay(spec.id, { showLedger: v })} />
                    </Row>
                  </>
                )}
              </>
            )}
            {tab === "about" && (
              <div className="space-y-2 text-[11px] text-muted-foreground">
                <div>
                  <span className="text-foreground">{spec.fileName}</span> · © {spec.author} · {spec.license}
                </div>
                <div>
                  Status: <span className={cn(spec.status === "supported unchanged" ? "text-[#0ecb81]" : "text-[#f0b90b]")}>{spec.status}</span>
                </div>
                {spec.compatNotes && <div>{spec.compatNotes}</div>}
                <ul className="list-disc pl-4">
                  {spec.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                {meta && (
                  <div className="rounded border border-border p-2 font-mono text-[10px]">
                    last run: {meta.bars} bars ({new Date(meta.firstTime * 1000).toISOString().slice(0, 10)} → {new Date(meta.lastTime * 1000).toISOString().slice(0, 10)}), {meta.durationMs} ms, warm-up {meta.warmupBars} bars, gaps {meta.gaps} ({meta.missingBars} missing bars), price scale ×{meta.priceScale}, Pine v{meta.pineVersion ?? "?"}
                  </div>
                )}
                {state?.result?.warnings.length ? (
                  <ul className="list-disc pl-4 text-[#f0b90b]">
                    {state.result.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                {state?.status === "error" && <div className="text-[#f6465d]">{state.stage}: {state.error}</div>}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <button onClick={() => setPineParams(spec.id, {})} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
            <RotateCcw className="h-3 w-3" /> Reset to script defaults
          </button>
          <span className="text-[10px] text-muted-foreground">{Object.keys(params).length} override{Object.keys(params).length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}
