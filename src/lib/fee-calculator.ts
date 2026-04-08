/**
 * Compute the user-facing transaction fee for a Solana tx.
 *
 * Formula:
 *
 *   fee_lamports = (numSignatures * 5000) +
 *                  floor(compute_unit_price_micro_lamports * units_consumed / 1_000_000)
 *
 * The base fee is 5000 lamports per signature. The priority fee is set by a
 * `SetComputeUnitPrice` Compute Budget instruction (discriminator 3, u64 LE
 * micro-lamports per CU). If the tx doesn't set one, the priority fee is 0.
 *
 * Parsing of the raw transaction now lives in `tx-parser.ts`; this module
 * only walks the already-parsed instruction list to extract Compute Budget
 * settings, then does the math.
 */

import type { ParsedTransaction } from "@/types";
import { LAMPORTS_PER_SOL } from "./constants";
import { parseTransaction, readCompactU16, readU64LE } from "./tx-parser";

/** Re-export the shortvec reader so existing fee-calculator tests stay green. */
export { readCompactU16 };

/** Base fee charged per signature, in lamports. Hard-coded by the runtime. */
export const BASE_LAMPORTS_PER_SIGNATURE = 5000;

/** Compute Budget program ID. */
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Discriminator byte for the SetComputeUnitPrice instruction. */
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

/** Discriminator byte for the SetComputeUnitLimit instruction. */
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;

/** Inputs needed to compute a transaction fee. */
export interface TxFeeInputs {
  /** Number of required signatures (top of the wire format). */
  numSignatures: number;
  /** Compute unit price in micro-lamports/CU; 0 when no priority fee was set. */
  computeUnitPriceMicroLamports: number;
  /** Compute unit limit set by the tx, or null when not explicitly set. */
  computeUnitLimit: number | null;
}

/**
 * Walks a parsed transaction's instruction list and extracts the Compute
 * Budget settings needed to compute the fee. Default values (price=0,
 * limit=null) are returned for txs that don't include those instructions.
 */
export function getFeeInputs(parsed: ParsedTransaction): TxFeeInputs {
  let computeUnitPriceMicroLamports = 0;
  let computeUnitLimit: number | null = null;

  for (const inst of parsed.instructions) {
    if (inst.programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    if (inst.data.length === 0) continue;

    const discriminator = inst.data[0];
    if (discriminator === SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR && inst.data.length >= 9) {
      computeUnitPriceMicroLamports = readU64LE(inst.data, 1);
    } else if (discriminator === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR && inst.data.length >= 5) {
      computeUnitLimit =
        inst.data[1] |
        (inst.data[2] << 8) |
        (inst.data[3] << 16) |
        (inst.data[4] << 24);
    }
  }

  return {
    numSignatures: parsed.numSignatures,
    computeUnitPriceMicroLamports,
    computeUnitLimit,
  };
}

/**
 * Computes the SOL fee given parsed inputs and the simulation's CU usage.
 *
 * `unitsConsumed` is the actual CU used by the simulation, which is what the
 * runtime would charge against. We deliberately do not use the requested
 * compute unit limit because consumed < requested in almost every case.
 */
export function calculateFeeSol(
  inputs: TxFeeInputs,
  unitsConsumed: number,
): number {
  const baseLamports = inputs.numSignatures * BASE_LAMPORTS_PER_SIGNATURE;
  // Reason: micro-lamports / 1_000_000 = lamports. Floor to avoid fractional lamports.
  const priorityLamports = Math.floor(
    (inputs.computeUnitPriceMicroLamports * unitsConsumed) / 1_000_000,
  );
  return (baseLamports + priorityLamports) / LAMPORTS_PER_SOL;
}

/**
 * Backwards-compatible wrapper: parses a base64 transaction and extracts fee
 * inputs in one call. The structural parser does the heavy lifting; this
 * wrapper exists so existing tests and the service worker can keep using a
 * single-step API when they don't need a full ParsedTransaction.
 */
export function parseTxFeeInputs(base64Tx: string): TxFeeInputs | null {
  const parsed = parseTransaction(base64Tx);
  if (!parsed) return null;
  return getFeeInputs(parsed);
}
