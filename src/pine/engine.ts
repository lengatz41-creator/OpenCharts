/**
 * Main-thread client for the Pine engine.
 *
 * Runs scripts in a Web Worker (lazily created, so PineTS — ~800 KB — is never
 * part of the first-load bundle) and caches results by
 * (script, symbol, timeframe, volume mode, params, candle fingerprint). Where
 * `Worker` is unavailable (tests, old embedders) it falls back to a dynamic
 * import of the runner on the main thread.
 */
import { pineRunKey } from "./cache-key.ts";
import type { PineInputMeta, PineRunRequest, PineRunResult } from "./types.ts";
import type { PineWorkerRequest, PineWorkerResponse } from "./pine.worker.ts";

const CACHE_MAX = 32;

type Pending = { resolve: (v: PineWorkerResponse) => void; reject: (e: Error) => void };
/** `Omit` that distributes over a union instead of collapsing it to common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

class PineEngine {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private cache = new Map<string, PineRunResult>();
  private inflight = new Map<string, Promise<PineRunResult>>();
  private describeCache = new Map<string, Promise<PineInputMeta[]>>();

  private getWorker(): Worker | null {
    if (this.worker || this.workerBroken) return this.worker;
    if (typeof Worker === "undefined") return null;
    try {
      const worker = new Worker(new URL("./pine.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<PineWorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data);
      };
      worker.onerror = (ev) => {
        // The worker failed to load (e.g. a host that blocks module workers):
        // fail every pending call and fall back to in-thread execution.
        console.error("[pine] worker error; falling back to main thread", ev.message);
        this.workerBroken = true;
        for (const p of this.pending.values()) p.reject(new Error("pine worker failed"));
        this.pending.clear();
        worker.terminate();
        this.worker = null;
      };
      this.worker = worker;
    } catch (err) {
      console.error("[pine] cannot create worker; running on the main thread", err);
      this.workerBroken = true;
    }
    return this.worker;
  }

  private post(msg: DistributiveOmit<PineWorkerRequest, "id">): Promise<PineWorkerResponse> {
    const worker = this.getWorker();
    if (!worker) return Promise.reject(new Error("no worker"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id } as PineWorkerRequest);
    });
  }

  /** Run a script, served from cache when the same window was computed before. */
  run(request: PineRunRequest): Promise<PineRunResult> {
    const key = pineRunKey(request);
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const task = this.execute(request)
      .then((result) => {
        this.cache.set(key, result);
        while (this.cache.size > CACHE_MAX) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async execute(request: PineRunRequest): Promise<PineRunResult> {
    if (this.getWorker()) {
      try {
        const res = await this.post({ type: "run", request });
        if (!res.ok) return { ok: false, scriptId: request.scriptId, stage: "run", error: res.error };
        if (res.type !== "run") throw new Error("unexpected worker reply");
        return res.result;
      } catch (err) {
        if (!this.workerBroken) {
          return { ok: false, scriptId: request.scriptId, stage: "run", error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    const { runPineScript } = await import("./runner.ts");
    return runPineScript(request);
  }

  /** Input metadata (titles, defaults, ranges) for the settings UI. */
  describe(scriptId: string): Promise<PineInputMeta[]> {
    let p = this.describeCache.get(scriptId);
    if (!p) {
      p = this.describeExecute(scriptId);
      p.catch(() => this.describeCache.delete(scriptId));
      this.describeCache.set(scriptId, p);
    }
    return p;
  }

  private async describeExecute(scriptId: string): Promise<PineInputMeta[]> {
    if (this.getWorker()) {
      try {
        const res = await this.post({ type: "describe", scriptId });
        if (!res.ok) throw new Error(res.error);
        if (res.type !== "describe") throw new Error("unexpected worker reply");
        return res.inputs;
      } catch (err) {
        if (!this.workerBroken) throw err;
      }
    }
    const { describePineScript } = await import("./runner.ts");
    return describePineScript(scriptId);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const pineEngine = new PineEngine();
