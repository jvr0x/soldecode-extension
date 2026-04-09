/**
 * SolDecode service worker — runs in the background (Manifest V3).
 * Orchestrates: receive tx → simulate → decode → risk analyze → return preview.
 */

import { simulateTransaction, getSignatureStatus, getTransaction } from "./lib/simulator";
import { decodeSimulation } from "./lib/simulation-decoder";
import { calculateFeeSol, getFeeInputs, BASE_LAMPORTS_PER_SIGNATURE } from "./lib/fee-calculator";
import { parseTransaction } from "./lib/tx-parser";
import { LAMPORTS_PER_SOL, KNOWN_CONTACTS_KEY, MAX_KNOWN_CONTACTS } from "./lib/constants";
import { extractOutgoingDestinations } from "./lib/transfer-extractor";
import type { ExtensionSettings, SimulatedPreview } from "./types";

/**
 * Stores simulated previews keyed by their SIMULATE id, so the tracker can
 * later compare actual on-chain results against the preview the user approved.
 * TTL is 5 minutes — any tx not submitted within that window is dropped.
 */
const pendingPreviews = new Map<string, {
  preview: SimulatedPreview;
  userPubkey: string;
  stagedDestinations: string[];
  expiresAt: number;
}>();

/** In-memory cache of known-contact addresses, loaded lazily on first read. */
let cachedContacts: string[] | null = null;

/**
 * Loads the known-contacts list from chrome.storage.local the first time
 * it is needed and caches in memory for the rest of the service worker
 * lifetime. Lazy so we don't block service worker startup.
 */
async function getKnownContacts(): Promise<string[]> {
  if (cachedContacts !== null) return cachedContacts;
  try {
    const data = await chrome.storage.local.get(KNOWN_CONTACTS_KEY);
    const stored = data[KNOWN_CONTACTS_KEY];
    cachedContacts = Array.isArray(stored) ? (stored as string[]) : [];
  } catch {
    cachedContacts = [];
  }
  return cachedContacts;
}

/**
 * Appends new destinations to the known-contacts list, deduplicates while
 * preserving "most recent at end" order, enforces MAX_KNOWN_CONTACTS by
 * dropping oldest entries, persists to chrome.storage.local, and updates
 * the in-memory cache.
 */
async function commitContacts(newDestinations: string[]): Promise<void> {
  if (newDestinations.length === 0) return;
  const current = await getKnownContacts();
  // Reason: remove any prior occurrences of the new destinations so they
  // end up at the back of the list (most recently used).
  const newSet = new Set(newDestinations);
  const withoutNew = current.filter((c) => !newSet.has(c));
  const merged = [...withoutNew, ...newDestinations];
  // Enforce cap by dropping oldest.
  const capped = merged.length > MAX_KNOWN_CONTACTS
    ? merged.slice(merged.length - MAX_KNOWN_CONTACTS)
    : merged;
  cachedContacts = capped;
  try {
    await chrome.storage.local.set({ [KNOWN_CONTACTS_KEY]: capped });
  } catch (e) {
    console.warn("[SolDecode] Failed to persist contacts:", e);
  }
}

/**
 * Removes stale entries from pendingPreviews. Called opportunistically on
 * each TRACK_TX so the map doesn't grow unbounded.
 */
function cleanStalePreviews(): void {
  const now = Date.now();
  for (const [key, entry] of pendingPreviews) {
    if (entry.expiresAt < now) pendingPreviews.delete(key);
  }
}

/** Retrieves extension settings from chrome.storage.local. */
async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get("settings");
  const stored = data.settings as Partial<ExtensionSettings> | undefined;
  return {
    enabled: stored?.enabled ?? true,
    rpcEndpoint: stored?.rpcEndpoint ?? "",
    simulationTimeoutMs: stored?.simulationTimeoutMs ?? 30_000,
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
        simulationTimeoutMs: settings.simulationTimeoutMs,
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

        const knownContacts = await getKnownContacts();

        const preview = await decodeSimulation(
          simResult,
          parsed,
          userPubkey,
          origin,
          estimatedFee,
          knownContacts,
        );

        const stagedDestinations = extractOutgoingDestinations(parsed, userPubkey);

        pendingPreviews.set(id, {
          preview,
          userPubkey,
          stagedDestinations,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        sendResponse({ type: "SIMULATE_RESULT", id, preview });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown simulation error";
        sendResponse({ type: "SIMULATE_ERROR", id, error: errorMessage });
      }
    })();

    return true; // Signal async response
  }

  if (message.type === "TRACK_TX") {
    const { signature, userPubkey: trackPubkey } = message as {
      signature: string;
      userPubkey?: string | null;
    };
    const tabId = _sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "no tab id" });
      return;
    }
    cleanStalePreviews();
    // Find the most recent stored preview whose userPubkey matches and
    // which has not yet been consumed. We don't have the original SIMULATE
    // id in the track message — the tracker correlates by recency + user.
    let matchedPreview: SimulatedPreview | null = null;
    let matchedKey: string | null = null;
    let newestExpiry = 0;
    for (const [key, entry] of pendingPreviews) {
      if (entry.userPubkey !== trackPubkey) continue;
      if (entry.expiresAt > newestExpiry) {
        matchedPreview = entry.preview;
        matchedKey = key;
        newestExpiry = entry.expiresAt;
      }
    }
    if (matchedKey) {
      const entry = pendingPreviews.get(matchedKey);
      if (entry && entry.stagedDestinations.length > 0) {
        // Reason: only commit contacts after the wallet actually returned a
        // signature (which is what TRACK_TX proves). A rejected or dropped
        // tx should NOT end up poisoning the contacts store.
        commitContacts(entry.stagedDestinations).catch((e) => {
          console.warn("[SolDecode] commitContacts failed:", e);
        });
      }
      pendingPreviews.delete(matchedKey);
    }

    trackAndReport(signature, trackPubkey ?? "", matchedPreview, tabId).catch((err) => {
      console.warn("[SolDecode] trackAndReport failed:", err);
    });
    sendResponse({ ok: true });
    return true;
  }
});

/**
 * Polls the chain for a submitted tx and reports the final status back to
 * the originating tab via chrome.tabs.sendMessage. Fires one TX_STATUS
 * message with the final classification:
 *   CONFIRMED — finalized with effects matching the simulated preview
 *   DIVERGED  — finalized but actual balance changes differ ≥ 5%
 *   FAILED    — finalized with err !== null
 *   DROPPED   — never confirmed within the polling window
 */
async function trackAndReport(
  signature: string,
  userPubkey: string,
  simPreview: SimulatedPreview | null,
  tabId: number,
): Promise<void> {
  const POLL_INTERVAL_MS = 2000;
  const MAX_ATTEMPTS = 30; // 60 seconds

  let finalStatus: "CONFIRMED" | "DIVERGED" | "FAILED" | "DROPPED" = "DROPPED";
  let detail = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const status = await getSignatureStatus(signature);
      if (status) {
        if (status.err !== null) {
          finalStatus = "FAILED";
          detail = "Transaction failed on-chain.";
          break;
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          // Got it — fetch full tx and compute divergence.
          try {
            const tx = await getTransaction(signature);
            if (tx && simPreview) {
              const divergence = computeDivergence(tx, simPreview, userPubkey);
              if (divergence.diverged) {
                finalStatus = "DIVERGED";
                detail = divergence.detail;
              } else {
                finalStatus = "CONFIRMED";
                detail = "Balance changes match preview.";
              }
            } else {
              finalStatus = "CONFIRMED";
              detail = "Confirmed on-chain.";
            }
          } catch (e) {
            // Could not fetch the tx — still confirmed as a signature status.
            finalStatus = "CONFIRMED";
            detail = "Confirmed on-chain (tx fetch failed).";
          }
          break;
        }
      }
    } catch (e) {
      // RPC error on a single poll — keep trying.
      console.warn("[SolDecode] signature status poll error:", e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TX_STATUS",
      signature,
      status: finalStatus,
      detail,
    });
  } catch (e) {
    // Tab may have closed — nothing to do.
    console.warn("[SolDecode] TX_STATUS push failed:", e);
  }
}

/**
 * Compares the balance changes from a finalized tx against the simulated
 * preview's balance changes. Returns diverged=true if any simulated mint's
 * actual amount differs by ≥ 5% (or the mint is missing entirely from the
 * actual result).
 */
function computeDivergence(
  tx: NonNullable<Awaited<ReturnType<typeof getTransaction>>>,
  simPreview: SimulatedPreview,
  userPubkey: string,
): { diverged: boolean; detail: string } {
  const DIVERGENCE_THRESHOLD = 0.05;
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];

  // Compute actual SOL change for the user's pubkey.
  let actualSolLamports = 0;
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i] === userPubkey) {
      actualSolLamports += (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
    }
  }
  const actualSol = actualSolLamports / 1_000_000_000;

  // Compute actual token changes for the user's pubkey, keyed by mint.
  const actualTokens = new Map<string, number>();
  const pre = new Map<string, number>();
  for (const t of tx.meta.preTokenBalances ?? []) {
    if (t.owner !== userPubkey) continue;
    pre.set(`${t.accountIndex}-${t.mint}`, t.uiTokenAmount.uiAmount ?? 0);
  }
  for (const t of tx.meta.postTokenBalances ?? []) {
    if (t.owner !== userPubkey) continue;
    const key = `${t.accountIndex}-${t.mint}`;
    const preAmount = pre.get(key) ?? 0;
    const diff = (t.uiTokenAmount.uiAmount ?? 0) - preAmount;
    if (Math.abs(diff) > 0.000001) {
      actualTokens.set(t.mint, (actualTokens.get(t.mint) ?? 0) + diff);
    }
  }
  // Also handle tokens present pre but missing post (fully spent).
  for (const [key, preAmount] of pre) {
    const mint = key.slice(key.indexOf("-") + 1);
    if (!actualTokens.has(mint) && preAmount > 0) {
      actualTokens.set(mint, -preAmount);
    }
  }

  // For each simulated change, find the corresponding actual and compare.
  const diverged: string[] = [];
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const simulatedMints = new Set(simPreview.balanceChanges.map((c) => c.mint));

  for (const simChange of simPreview.balanceChanges) {
    const simAmount = simChange.amount;
    const actualAmount =
      simChange.mint === SOL_MINT
        ? actualSol
        : (actualTokens.get(simChange.mint) ?? 0);
    if (Math.abs(simAmount) < 1e-9) continue; // skip zero-amount sim entries
    const ratio = Math.abs(actualAmount - simAmount) / Math.abs(simAmount);
    if (ratio >= DIVERGENCE_THRESHOLD) {
      diverged.push(
        `${simChange.symbol}: expected ${simAmount.toFixed(6)}, got ${actualAmount.toFixed(6)}`,
      );
    }
  }

  // Catch "surprise" token mints — mints that showed up in the actual tx
  // but were NOT predicted by the simulation. This is the scenario where
  // a scam gives you a worthless copycat token with a symbol you recognize:
  // the simulation said you'd receive BONK, the actual result gave you
  // FAKE_BONK at a different mint address. Without this check the
  // per-simulated-mint loop above would miss it entirely because FAKE_BONK
  // is not in simPreview.balanceChanges.
  for (const [mint, actualAmount] of actualTokens) {
    if (simulatedMints.has(mint)) continue;
    if (Math.abs(actualAmount) < 0.000001) continue;
    const shortMint = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    diverged.push(
      `unexpected token ${shortMint}: simulation did not predict this, got ${actualAmount.toFixed(6)}`,
    );
  }

  // Catch "surprise" SOL change — the simulation had no SOL balance-change
  // entry, but the actual tx moved a non-trivial amount of SOL. The 0.01
  // threshold matches the fee-dust threshold used elsewhere so normal
  // network fees do not trigger a false divergence.
  if (!simulatedMints.has(SOL_MINT) && Math.abs(actualSol) >= 0.01) {
    diverged.push(
      `unexpected SOL: simulation did not predict this, got ${actualSol.toFixed(6)}`,
    );
  }

  if (diverged.length > 0) {
    return {
      diverged: true,
      detail: diverged.join("; "),
    };
  }
  return { diverged: false, detail: "" };
}

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
        simulationTimeoutMs: 30_000,
      } satisfies ExtensionSettings,
    });
  }
});
