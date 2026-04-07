import type { SimulationResult, BalanceChange, RiskLevel, RiskWarning } from "@/types";
import { SOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants";

/** SOL threshold above which an outgoing transfer is flagged as high-value. */
const HIGH_VALUE_SOL_THRESHOLD = 10;

/**
 * Detects token approval instructions in simulation logs.
 * Scans for "Instruction: Approve" lines that appear within a Token Program
 * invocation context.
 *
 * Reason: Approve instructions grant a program the ability to spend tokens
 * from the user's account without requiring further consent — a common
 * phishing vector.
 */
function detectTokenApprovals(logs: string[]): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  let inTokenProgram = false;

  for (const log of logs) {
    if (
      log.includes(`${TOKEN_PROGRAM_ID} invoke`) ||
      log.includes(`${TOKEN_2022_PROGRAM_ID} invoke`)
    ) {
      inTokenProgram = true;
    }

    if (inTokenProgram && log.includes("Instruction: Approve")) {
      warnings.push({
        severity: "critical",
        title: "Token Approval Detected",
        description:
          "This transaction grants a program permission to spend your tokens. " +
          "If the amount is unlimited, the program can drain your tokens at any time.",
      });
      // Reason: Reset after match so a single Token Program block only fires once.
      inTokenProgram = false;
    }

    if (
      log.includes(`${TOKEN_PROGRAM_ID} success`) ||
      log.includes(`${TOKEN_2022_PROGRAM_ID} success`)
    ) {
      inTokenProgram = false;
    }
  }

  return warnings;
}

/**
 * Detects high-value outgoing SOL transfers exceeding the threshold.
 * Reason: Large SOL movements warrant explicit user attention regardless
 * of the dApp context.
 */
function detectHighValue(balanceChanges: BalanceChange[]): RiskWarning[] {
  const solChange = balanceChanges.find((c) => c.mint === SOL_MINT);
  if (solChange && solChange.amount < -HIGH_VALUE_SOL_THRESHOLD) {
    return [
      {
        severity: "warning",
        title: "High Value Transaction",
        description: `This transaction will send ${Math.abs(solChange.amount).toFixed(2)} SOL from your wallet. Make sure this is intended.`,
      },
    ];
  }
  return [];
}

/**
 * Analyzes a simulation result for risk signals.
 * Checks for token approvals in logs and high-value SOL outflows.
 * Returns the overall risk level and the list of warnings found.
 */
export function analyzeRisks(
  sim: SimulationResult,
  balanceChanges: BalanceChange[],
): { risk: RiskLevel; warnings: RiskWarning[] } {
  const warnings: RiskWarning[] = [];

  warnings.push(...detectTokenApprovals(sim.logs ?? []));
  warnings.push(...detectHighValue(balanceChanges));

  // Reason: Any warning or critical finding escalates risk to WARNING.
  // DANGER is reserved for failed simulations (handled in simulation-decoder).
  let risk: RiskLevel = "SAFE";
  if (warnings.length > 0) {
    risk = "WARNING";
  }

  return { risk, warnings };
}
