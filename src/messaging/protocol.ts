import type { SimulatedPreview } from "@/types";

/** Messages from inject.ts → content-script.ts (via window.postMessage). */
export type InjectMessage =
  | {
      type: "SOLDECODE_SIMULATE";
      id: string;
      tx: string;
      origin: string;
    };

/** Messages from content-script.ts → inject.ts (via window.postMessage). */
export type ContentToInjectMessage =
  | {
      type: "SOLDECODE_RESULT";
      id: string;
      action: "PROCEED" | "REJECT";
    };

/** Messages from content-script.ts → service-worker.ts (via chrome.runtime). */
export type ContentToWorkerMessage =
  | {
      type: "SIMULATE";
      id: string;
      tx: string;
      origin: string;
    }
  | {
      type: "GET_SETTINGS";
    };

/** Messages from service-worker.ts → content-script.ts (via chrome.runtime response). */
export type WorkerResponse =
  | {
      type: "SIMULATE_RESULT";
      id: string;
      preview: SimulatedPreview;
    }
  | {
      type: "SIMULATE_ERROR";
      id: string;
      error: string;
    }
  | {
      type: "SETTINGS";
      enabled: boolean;
      configured: boolean;
    };

/** Generates a unique message ID. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Type guard for SolDecode messages from inject.ts. */
export function isInjectMessage(data: unknown): data is InjectMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: string }).type === "SOLDECODE_SIMULATE"
  );
}

/** Type guard for SolDecode result messages from content-script.ts. */
export function isResultMessage(data: unknown): data is ContentToInjectMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: string }).type === "SOLDECODE_RESULT"
  );
}
