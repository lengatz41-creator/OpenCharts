/**
 * Web Worker entry: runs Pine scripts off the main thread so a 10k-bar
 * evaluation never stalls chart interaction. Messages are plain JSON; see
 * `engine.ts` for the client side.
 */
import { describePineScript, runPineScript } from "./runner.ts";
import type { PineInputMeta, PineRunRequest, PineRunResult } from "./types.ts";

export type PineWorkerRequest =
  | { id: number; type: "run"; request: PineRunRequest }
  | { id: number; type: "describe"; scriptId: string };

export type PineWorkerResponse =
  | { id: number; ok: true; type: "run"; result: PineRunResult }
  | { id: number; ok: true; type: "describe"; inputs: PineInputMeta[] }
  | { id: number; ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PineWorkerRequest>) => void) | null;
  postMessage: (m: PineWorkerResponse) => void;
};

scope.onmessage = async (e: MessageEvent<PineWorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "run") {
      const result = await runPineScript(msg.request);
      scope.postMessage({ id: msg.id, ok: true, type: "run", result });
    } else {
      scope.postMessage({ id: msg.id, ok: true, type: "describe", inputs: describePineScript(msg.scriptId) });
    }
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
