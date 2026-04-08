import type { SimulationResult, ExtensionSettings } from "@/types";
import { DEFAULT_RPC_ENDPOINT } from "./constants";

/** Gets RPC endpoint from extension settings. */
async function getRpcEndpoint(): Promise<string> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const data = await chrome.storage.local.get("settings");
    const settings = data.settings as ExtensionSettings | undefined;
    if (settings?.rpcEndpoint) return settings.rpcEndpoint;
  }
  return DEFAULT_RPC_ENDPOINT;
}

/**
 * Simulates an unsigned transaction via Solana RPC.
 * Uses sigVerify: false (unsigned) and replaceRecentBlockhash: true.
 */
export async function simulateTransaction(base64Tx: string): Promise<SimulationResult> {
  const endpoint = await getRpcEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        base64Tx,
        {
          encoding: "base64",
          commitment: "confirmed",
          replaceRecentBlockhash: true,
          sigVerify: false,
          innerInstructions: true,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`RPC error: ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result.value as SimulationResult;
}

/**
 * Polls the signature status of a submitted transaction.
 * Returns the status object or null when the signature is not yet known.
 */
export async function getSignatureStatus(signature: string): Promise<{
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
} | null> {
  const endpoint = await getRpcEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [[signature], { searchTransactionHistory: true }],
    }),
  });
  if (!response.ok) throw new Error(`RPC error: ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const entry = json.result?.value?.[0];
  return entry ?? null;
}

/**
 * Fetches the full finalized transaction including meta balance arrays.
 * Used after confirmation to compute actual balance changes for divergence
 * comparison against the simulated preview.
 */
export async function getTransaction(signature: string): Promise<{
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: { uiAmount: number | null };
    }>;
    postTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: { uiAmount: number | null };
    }>;
  };
  transaction: {
    message: {
      accountKeys: string[];
    };
  };
} | null> {
  const endpoint = await getRpcEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "json",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`RPC error: ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result ?? null;
}
