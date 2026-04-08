/**
 * SolDecode service worker — runs in the background (Manifest V3).
 * Orchestrates: receive tx → simulate → decode → risk analyze → return preview.
 */

import { simulateTransaction } from "./lib/simulator";
import { decodeSimulation } from "./lib/simulation-decoder";
import type { ExtensionSettings } from "./types";

/** Base58 alphabet used by Solana. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encodes a byte array to a base58 string.
 * Used to convert raw 32-byte public keys to Solana address strings.
 */
function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let result = "";
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    result = BASE58_ALPHABET[Number(remainder)] + result;
  }

  // Preserve leading zero bytes as "1" characters (Solana convention).
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }

  return result || "1";
}

/**
 * Extracts the ordered account key list from a base64-encoded transaction.
 * Performs minimal binary parsing of the transaction message header.
 * Reason: decodeSimulation needs the account list to map balance indices to pubkeys.
 */
function extractAccountKeys(base64Tx: string): string[] {
  try {
    const binary = atob(base64Tx);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // The first compact-u16 encodes the number of signatures.
    // For values < 128 this is a single byte.
    const numSignatures = bytes[0];
    let offset = 1 + numSignatures * 64; // each signature is 64 bytes

    // Versioned transactions (v0) have a version prefix byte (0x80) after signatures.
    if (bytes[offset] === 0x80) {
      offset += 1;
    }

    // Message header: 3 bytes
    // [numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]
    offset += 3;

    // Number of account keys (compact-u16, single byte for < 128 accounts).
    const numAccounts = bytes[offset];
    offset += 1;

    const accounts: string[] = [];
    for (let i = 0; i < numAccounts && offset + 32 <= bytes.length; i++) {
      const keyBytes = bytes.slice(offset, offset + 32);
      accounts.push(base58Encode(keyBytes));
      offset += 32;
    }

    return accounts;
  } catch {
    return [];
  }
}

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
        const accountKeys = extractAccountKeys(tx);
        // Prefer the wallet-provided pubkey: in gasless flows the on-chain
        // fee payer is a relayer, not the user, so accountKeys[0] would
        // resolve balance changes against the wrong account.
        const userPubkey = providedPubkey && providedPubkey.length > 0
          ? providedPubkey
          : accountKeys[0] ?? "";

        const preview = await decodeSimulation(simResult, userPubkey, accountKeys, origin);

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
