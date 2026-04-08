/**
 * SolDecode service worker — runs in the background (Manifest V3).
 * Orchestrates: receive tx → simulate → decode → risk analyze → return preview.
 */

import { simulateTransaction } from "./lib/simulator";
import { decodeSimulation } from "./lib/simulation-decoder";
import { calculateFeeSol, getFeeInputs, BASE_LAMPORTS_PER_SIGNATURE } from "./lib/fee-calculator";
import { parseTransaction } from "./lib/tx-parser";
import { LAMPORTS_PER_SOL } from "./lib/constants";
import type { ExtensionSettings } from "./types";

/** Retrieves extension settings from chrome.storage.local. */
async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get("settings");
  return (data.settings as ExtensionSettings | undefined) ?? {
    enabled: true,
    rpcEndpoint: "",
  };
}

/**
 * Handles messages from content scripts.
 * Supports GET_SETTINGS and SIMULATE message types.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_SETTINGS") {
    getSettings().then((settings) => {
      sendResponse({
        type: "SETTINGS",
        enabled: settings.enabled,
        configured: settings.rpcEndpoint.length > 0,
      });
    });
    return true; // Signal async response
  }

  if (message.type === "SIMULATE") {
    const { id, tx, origin, userPubkey: providedPubkey } = message as {
      id: string;
      tx: string;
      origin: string;
      userPubkey?: string | null;
    };

    (async () => {
      try {
        const simResult = await simulateTransaction(tx);

        // Parse the transaction once and reuse the result for both fee math
        // and risk analysis. parseTransaction returns null on malformed bytes;
        // in that case we degrade to a stub with empty instructions so the
        // pipeline still produces a (less detailed) preview.
        const parsed = parseTransaction(tx) ?? {
          numSignatures: 1,
          accountKeys: [],
          instructions: [],
          versioned: false,
        };

        // Prefer the wallet-provided pubkey: in gasless flows the on-chain
        // fee payer is a relayer, not the user, so accountKeys[0] would
        // resolve balance changes against the wrong account.
        const userPubkey =
          providedPubkey && providedPubkey.length > 0
            ? providedPubkey
            : parsed.accountKeys[0] ?? "";

        // Compute the real fee from parsed Compute Budget settings + actual
        // CU usage. Falls back to a conservative single-signature base fee
        // when the tx couldn't be parsed.
        const feeInputs = getFeeInputs(parsed);
        const estimatedFee = parsed.accountKeys.length > 0
          ? calculateFeeSol(feeInputs, simResult.unitsConsumed)
          : BASE_LAMPORTS_PER_SIGNATURE / LAMPORTS_PER_SOL;

        const preview = await decodeSimulation(
          simResult,
          parsed,
          userPubkey,
          origin,
          estimatedFee,
        );

        sendResponse({ type: "SIMULATE_RESULT", id, preview });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown simulation error";
        sendResponse({ type: "SIMULATE_ERROR", id, error: errorMessage });
      }
    })();

    return true; // Signal async response
  }
});

/**
 * Initializes default settings on first install.
 * Does not overwrite existing settings on update.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("settings");
  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: {
        enabled: true,
        rpcEndpoint: "",
      } satisfies ExtensionSettings,
    });
  }
});
