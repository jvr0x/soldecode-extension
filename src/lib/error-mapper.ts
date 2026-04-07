import type { ErrorExplanation } from "@/types";

const JUPITER_ERRORS: Record<number, { title: string; reason: string; fixes: string[] }> = {
  6001: {
    title: "Slippage Exceeded",
    reason: "The price moved more than your slippage tolerance between when you submitted the transaction and when it was processed.",
    fixes: [
      "Increase slippage tolerance to 2-3% in swap settings",
      "Use a higher priority fee to get processed faster",
      "Try during lower-traffic periods",
    ],
  },
  6000: {
    title: "Swap Failed",
    reason: "The swap route became invalid before the transaction was processed. This often happens when liquidity pools shift.",
    fixes: [
      "Retry the swap — routes are recalculated each time",
      "Try a smaller swap amount",
      "Use a different route if available",
    ],
  },
};

const INSTRUCTION_ERRORS: Record<string, { title: string; reason: string; fixes: string[] }> = {
  InsufficientFunds: {
    title: "Insufficient Funds",
    reason: "Your wallet doesn't have enough SOL or tokens to complete this transaction, including fees and rent.",
    fixes: [
      "Check your balance — you need enough for the amount + transaction fees",
      "Keep at least 0.01 SOL for fees and rent-exempt reserves",
      "If swapping, reduce the input amount slightly",
    ],
  },
  AccountNotFound: {
    title: "Account Not Found",
    reason: "One of the accounts referenced in this transaction doesn't exist on-chain.",
    fixes: [
      "Verify the recipient address is correct",
      "The token account may need to be created first — this usually happens automatically",
    ],
  },
  InvalidAccountData: {
    title: "Invalid Account Data",
    reason: "An account involved in this transaction has unexpected data. This can happen when interacting with upgraded or migrated programs.",
    fixes: [
      "Refresh the page and retry",
      "The program may have been upgraded — check for app updates",
    ],
  },
  AccountAlreadyInitialized: {
    title: "Account Already Exists",
    reason: "The transaction tried to create an account that already exists.",
    fixes: [
      "This is usually safe to retry — the account exists and can be used",
    ],
  },
};

const TOP_LEVEL_ERRORS: Record<string, { title: string; reason: string; fixes: string[] }> = {
  BlockhashNotFound: {
    title: "Transaction Expired",
    reason: "Your transaction expired before it could be processed. Solana transactions have a short validity window (~60 seconds).",
    fixes: [
      "Retry the transaction — a fresh blockhash will be used",
      "Use a higher priority fee during congestion",
      "Network was likely congested when you submitted",
    ],
  },
  AlreadyProcessed: {
    title: "Already Processed",
    reason: "This exact transaction was already submitted and processed.",
    fixes: [
      "Check your wallet — the action may have already succeeded",
    ],
  },
};

/**
 * Maps a Solana transaction error into a human-readable explanation.
 * Handles top-level errors, instruction errors, and program-specific custom codes.
 */
export function mapError(err: unknown, source: string | undefined): ErrorExplanation {
  if (!err) {
    return {
      title: "Transaction Failed",
      reason: "The transaction failed but no specific error was provided.",
      fixes: ["Retry the transaction", "Check your wallet balance"],
      rawError: "unknown",
    };
  }

  if (typeof err === "string") {
    const mapped = TOP_LEVEL_ERRORS[err];
    if (mapped) {
      return { ...mapped, rawError: err };
    }
    return {
      title: "Transaction Failed",
      reason: `The network rejected this transaction: ${err}`,
      fixes: ["Retry the transaction"],
      rawError: err,
    };
  }

  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const instructionErr = (err as { InstructionError: [number, unknown] }).InstructionError;
    const [, detail] = instructionErr;

    if (typeof detail === "string") {
      const mapped = INSTRUCTION_ERRORS[detail];
      if (mapped) {
        return { ...mapped, rawError: `InstructionError: ${detail}` };
      }
      return {
        title: "Transaction Failed",
        reason: `A program instruction failed: ${detail}`,
        fixes: ["Retry the transaction"],
        rawError: `InstructionError: ${detail}`,
      };
    }

    if (typeof detail === "object" && detail !== null && "Custom" in detail) {
      const code = (detail as { Custom: number }).Custom;

      if (source === "JUPITER" || source === "Jupiter") {
        const jupErr = JUPITER_ERRORS[code];
        if (jupErr) {
          return { ...jupErr, rawError: `Custom program error: ${code}` };
        }
      }

      return {
        title: "Transaction Failed",
        reason: `The program returned error code ${code}. This is a program-specific error that we couldn't map to a known issue.`,
        fixes: [
          "Retry the transaction",
          "Check the dApp's documentation or support for this error code",
        ],
        rawError: `Custom program error: ${code}`,
      };
    }
  }

  return {
    title: "Transaction Failed",
    reason: "The transaction failed with an unexpected error format.",
    fixes: ["Retry the transaction"],
    rawError: JSON.stringify(err),
  };
}
