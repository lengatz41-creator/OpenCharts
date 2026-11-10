/**
 * Per-script parameter overrides, volume mode and display toggles, persisted
 * in localStorage and exposed through a tiny external store so the toolbar,
 * the settings dialog and the chart all read the same values without prop
 * plumbing through the terminal context.
 */
import { safeStorage } from "../lib/safe-storage.ts";
import type { PineParams, PineVolumeMode } from "./types.ts";

const PARAMS_PREFIX = "pine_params:";
const VOLUME_PREFIX = "pine_volume_mode:";
const DISPLAY_PREFIX = "pine_display:";

export interface PineDisplayOptions {
  /** Draw the strategy's broker fills (entries/exits) as markers. */
  showFills: boolean;
  /** Show the strategy ledger panel on the chart. */
  showLedger: boolean;
  /** Apply the script's `barcolor()` output to the candles. */
  paintBars: boolean;
  /** Draw `bgcolor()` bands. */
  showBackground: boolean;
}

const DISPLAY_DEFAULTS: PineDisplayOptions = {
  showFills: true,
  showLedger: false,
  paintBars: true,
  showBackground: true,
};

const listeners = new Set<() => void>();
let version = 0;
let settingsOpenFor: string | null = null;

function emit(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

function readJson<T>(key: string): T | null {
  const raw = safeStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getPineParams(scriptId: string): PineParams {
  return readJson<PineParams>(PARAMS_PREFIX + scriptId) ?? {};
}

export function setPineParams(scriptId: string, params: PineParams): void {
  if (Object.keys(params).length === 0) safeStorage.removeItem(PARAMS_PREFIX + scriptId);
  else safeStorage.setItem(PARAMS_PREFIX + scriptId, JSON.stringify(params));
  emit();
}

export function getPineVolumeMode(symbol: string): PineVolumeMode {
  return safeStorage.getItem(VOLUME_PREFIX + symbol) === "approx-base" ? "approx-base" : "quote";
}

export function setPineVolumeMode(symbol: string, mode: PineVolumeMode): void {
  safeStorage.setItem(VOLUME_PREFIX + symbol, mode);
  emit();
}

export function getPineDisplay(scriptId: string): PineDisplayOptions {
  return { ...DISPLAY_DEFAULTS, ...(readJson<Partial<PineDisplayOptions>>(DISPLAY_PREFIX + scriptId) ?? {}) };
}

export function setPineDisplay(scriptId: string, patch: Partial<PineDisplayOptions>): void {
  safeStorage.setItem(DISPLAY_PREFIX + scriptId, JSON.stringify({ ...getPineDisplay(scriptId), ...patch }));
  emit();
}

export function getPineSettingsOpenFor(): string | null {
  return settingsOpenFor;
}

export function openPineSettings(scriptId: string | null): void {
  settingsOpenFor = scriptId;
  emit();
}

export function getPineStoreVersion(): number {
  return version;
}

export function subscribePineStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
