import type {
  SimulationResult,
  SimulatedPreview,
  BalanceChange,
  RiskLevel,
} from "@/types";
import { getTokenInfo } from "./token-cache";
import { mapError } from "./error-mapper";
import { parseInstructionLogs } from "./instruction-parser";
import { analyzeRisks } from "./risk-analyzer";
import { SOL_MINT, LAMPORTS_PER_SOL } from "./constants";

/**
 * Computes the net SOL balance change for the user's main account.
 * Only the account whose key matches userPubkey is considered.
 * Returns the change in SOL (not lamports), negative = outgoing.
 */
function computeSolChange(
  sim: SimulationResult,
  userPubkey: string,
  accountKeys: string[],
): number {
  let totalLamports = 0;
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i] === userPubkey) {
      const pre = sim.preBalances[i] ?? 0;
      const post = sim.postBalances[i] ?? 0;
      totalLamports += post - pre;
    }
  }
  return totalLamports / LAMPORTS_PER_SOL;
}

/**
 * Computes token balance changes for all token accounts owned by userPubkey.
 * Diffs preTokenBalances vs postTokenBalances keyed by (accountIndex, mint).
 * Fetches token metadata for each changed mint.
 */
async function computeTokenChanges(
  sim: SimulationResult,
  userPubkey: string,
): Promise<BalanceChange[]> {
  const changes: BalanceChange[] = [];

  // Build pre-balance lookup keyed by "accountIndex-mint" for user's accounts only.
  const preMap = new Map<string, number>();
  for (const bal of sim.preTokenBalances) {
    if (bal.owner === userPubkey) {
      preMap.set(`${bal.accountIndex}-${bal.mint}`, bal.uiTokenAmount.uiAmount ?? 0);
    }
  }

  // Build post-balance lookup for user's accounts.
  const postMap = new Map<string, { mint: string; amount: number }>();
  for (const bal of sim.postTokenBalances) {
    if (bal.owner === userPubkey) {
      postMap.set(`${bal.accountIndex}-${bal.mint}`, {
        mint: bal.mint,
        amount: bal.uiTokenAmount.uiAmount ?? 0,
      });
    }
  }

  // Diff tokens present in post (covers new receipts and changed balances).
  const seen = new Set<string>();
  for (const [key, post] of postMap) {
    const pre = preMap.get(key) ?? 0;
    const diff = post.amount - pre;
    if (Math.abs(diff) > 0.000001) {
      const token = await getTokenInfo(post.mint);
      changes.push({
        mint: post.mint,
        symbol: token.symbol,
        name: token.name,
        amount: diff,
        decimals: token.decimals,
        logoURI: token.logoURI,
      });
    }
    seen.add(key);
  }

  // Tokens that existed in pre but vanished entirely in post (fully spent).
  for (const [key, preAmount] of preMap) {
    if (!seen.has(key) && preAmount > 0) {
      // Reason: key format is "accountIndex-mint"; mint starts after first dash.
      const mint = key.slice(key.indexOf("-") + 1);
      const token = await getTokenInfo(mint);
      changes.push({
        mint,
        symbol: token.symbol,
        name: token.name,
        amount: -preAmount,
        decimals: token.decimals,
        logoURI: token.logoURI,
      });
    }
  }

  return changes;
}

/** Jupiter program IDs used to detect Jupiter as the error source. */
const JUPITER_PROGRAM_IDS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX7rE",
]);

/**
 * Infers the error source from simulation logs by checking which known
 * program appears in top-level invocations.
 * Reason: mapError needs a source hint ("JUPITER") to resolve custom error codes.
 */
function detectErrorSource(logs: string[]): string | undefined {
  for (const log of logs) {
    const match = log.match(/^Program (\S+) invoke \[1\]$/);
    if (match && JUPITER_PROGRAM_IDS.has(match[1])) {
      return "JUPITER";
    }
  }
  return undefined;
}

/**
 * Generates a one-line plain-English summary from balance changes.
 * Falls back to generic descriptions when the pattern is unclear.
 */
function buildSummary(balanceChanges: BalanceChange[], failed: boolean): string {
  if (failed) return "This transaction would fail if submitted now.";
  if (balanceChanges.length === 0) return "No balance changes detected.";

  const outgoing = balanceChanges.filter((c) => c.amount < 0);
  const incoming = balanceChanges.filter((c) => c.amount > 0);

  if (outgoing.length > 0 && incoming.length > 0) {
    const out = outgoing[0];
    const inc = incoming[0];
    return `Swap ${Math.abs(out.amount)} ${out.symbol} for ${inc.amount} ${inc.symbol}`;
  }
  if (outgoing.length > 0) {
    const out = outgoing[0];
    return `Send ${Math.abs(out.amount)} ${out.symbol}`;
  }
  if (incoming.length > 0) {
    const inc = incoming[0];
    return `Receive ${inc.amount} ${inc.symbol}`;
  }
  return "Transaction processed.";
}

/**
 * Decodes a raw simulateTransaction result into a SimulatedPreview.
 * Orchestrates SOL/token balance diffing, log parsing, risk analysis,
 * and error mapping into a single human-readable structure.
 *
 * @param sim - Raw RPC simulation response.
 * @param userPubkey - The wallet address to track balance changes for.
 * @param accountKeys - Ordered account keys from the transaction message.
 * @param origin - The dApp URL that triggered the simulation.
 */
export async function decodeSimulation(
  sim: SimulationResult,
  userPubkey: string,
  accountKeys: string[],
  origin: string,
): Promise<SimulatedPreview> {
  const failed = sim.err !== null;

  // Compute balance changes for the user's accounts.
  const solChange = computeSolChange(sim, userPubkey, accountKeys);
  const tokenChanges = await computeTokenChanges(sim, userPubkey);

  const balanceChanges: BalanceChange[] = [];
  if (Math.abs(solChange) > 0.000001) {
    balanceChanges.push({
      mint: SOL_MINT,
      symbol: "SOL",
      name: "Solana",
      amount: solChange,
      decimals: 9,
      logoURI: null,
    });
  }
  balanceChanges.push(...tokenChanges);

  // Parse top-level program invocations from logs into step descriptions.
  const steps = parseInstructionLogs(sim.logs ?? []);

  // Run risk analysis over logs and balance changes.
  const { risk, warnings } = analyzeRisks(sim, balanceChanges);

  // Detect error source from logs to enable program-specific error mapping.
  // Reason: mapError needs "JUPITER" to translate Jupiter custom error codes.
  const errorSource = detectErrorSource(sim.logs ?? []);

  // Map error details if simulation failed.
  const error = failed ? mapError(sim.err, errorSource) : undefined;

  // Reason: A failed simulation is always DANGER regardless of risk analysis,
  // since the transaction cannot succeed in its current state.
  const finalRisk: RiskLevel = failed ? "DANGER" : risk;

  const summary = buildSummary(balanceChanges, failed);

  // Rough fee estimate: unitsConsumed * base fee per CU (1 lamport/CU = 1e-9 SOL/CU).
  const estimatedFee = sim.unitsConsumed * 0.000000001;

  return {
    risk: finalRisk,
    summary,
    balanceChanges,
    steps,
    warnings,
    error,
    estimatedFee,
    computeUnits: sim.unitsConsumed,
    origin,
  };
}
