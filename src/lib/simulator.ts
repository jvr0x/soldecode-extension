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
