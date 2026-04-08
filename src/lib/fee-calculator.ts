/**
 * Compute the user-facing transaction fee for a Solana tx.
 *
 * The previous implementation multiplied `unitsConsumed * 1e-9`, which is
 * meaningless: it treats every consumed CU as costing exactly one lamport,
 * ignores the per-signature base fee, and ignores any priority fee that the
 * dApp set via the Compute Budget program. The result was off by 50× or more
 * for typical Jupiter swaps.
 *
 * The correct formula in Solana is:
 *
 *   fee_lamports = (numSignatures * 5000) +
 *                  (compute_unit_price_micro_lamports * units_consumed / 1_000_000)
 *
 * The base fee is 5000 lamports per signature. The priority fee is set by a
 * `SetComputeUnitPrice` Compute Budget instruction (discriminator 3, u64 LE
 * micro-lamports per CU). If the tx doesn't set one, the priority fee is 0.
 */

import { LAMPORTS_PER_SOL } from "./constants";

/** Base fee charged per signature, in lamports. Hard-coded by the runtime. */
export const BASE_LAMPORTS_PER_SIGNATURE = 5000;

/** Compute Budget program ID. */
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Discriminator byte for the SetComputeUnitPrice instruction. */
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

/** Discriminator byte for the SetComputeUnitLimit instruction (parsed but unused for fee math). */
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;

/** Base58 alphabet — kept inline so the module is dependency-free. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
 * Reads a Solana compact-u16 ("shortvec") starting at `offset`.
 * Returns the decoded value and the number of bytes consumed (1, 2, or 3).
 *
 * Format: each byte uses 7 bits of value; the high bit signals "more bytes".
 * Max representable value is 16383.
 */
export function readCompactU16(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + i >= bytes.length) {
      throw new Error("readCompactU16: ran past end of buffer");
    }
    const byte = bytes[offset + i];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead: i + 1 };
    }
    shift += 7;
  }
  // Reason: a fourth continuation byte means the encoder is malformed.
  throw new Error("readCompactU16: continuation past 3 bytes");
}

/** Reads a little-endian u64 starting at `offset` and returns it as a JS number. */
function readU64LE(bytes: Uint8Array, offset: number): number {
  if (offset + 8 > bytes.length) {
    throw new Error("readU64LE: ran past end of buffer");
  }
  // Reason: BigInt is correct for u64 but the values we care about
  // (compute unit prices) comfortably fit in JS Number's 53-bit safe range.
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return Number(result);
}

/** Encodes a 32-byte public key as base58. */
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
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result || "1";
}

/** Decodes a base64 string to bytes without depending on Buffer. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parses a base64-encoded transaction and extracts everything needed to
 * compute the fee. Handles both legacy and versioned (v0) transactions.
 *
 * Returns `null` if the bytes can't be parsed — caller should fall back
 * to a conservative estimate rather than throwing into the user's face.
 */
export function parseTxFeeInputs(base64Tx: string): TxFeeInputs | null {
  try {
    const bytes = base64ToBytes(base64Tx);
    let offset = 0;

    // Signatures: compact-u16 count, then count * 64 raw bytes.
    const sigsHeader = readCompactU16(bytes, offset);
    const numSignatures = sigsHeader.value;
    offset += sigsHeader.bytesRead + numSignatures * 64;

    // Versioned tx prefix: 0x80 means v0.
    if (bytes[offset] === 0x80) {
      offset += 1;
    }

    // Message header: 3 bytes (numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned).
    offset += 3;

    // Account keys: compact-u16 count, then count * 32 raw pubkey bytes.
    const accountsHeader = readCompactU16(bytes, offset);
    const numAccounts = accountsHeader.value;
    offset += accountsHeader.bytesRead;

    const accountKeys: string[] = [];
    for (let i = 0; i < numAccounts; i++) {
      if (offset + 32 > bytes.length) return null;
      accountKeys.push(base58Encode(bytes.slice(offset, offset + 32)));
      offset += 32;
    }

    // Recent blockhash: 32 bytes.
    offset += 32;

    // Instructions: compact-u16 count, then per-instruction parsing.
    const instructionsHeader = readCompactU16(bytes, offset);
    const numInstructions = instructionsHeader.value;
    offset += instructionsHeader.bytesRead;

    let computeUnitPriceMicroLamports = 0;
    let computeUnitLimit: number | null = null;

    for (let i = 0; i < numInstructions; i++) {
      // Program ID index — 1 byte index into accountKeys.
      const programIdIndex = bytes[offset];
      offset += 1;

      // Account indices: compact-u16 count, then that many bytes.
      const accountsLen = readCompactU16(bytes, offset);
      offset += accountsLen.bytesRead + accountsLen.value;

      // Instruction data: compact-u16 length, then that many bytes.
      const dataLen = readCompactU16(bytes, offset);
      offset += dataLen.bytesRead;
      const dataStart = offset;
      const dataEnd = offset + dataLen.value;
      offset = dataEnd;

      // Reason: only Compute Budget instructions matter for fee math.
      if (accountKeys[programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) continue;
      if (dataLen.value === 0) continue;

      const discriminator = bytes[dataStart];
      if (discriminator === SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR && dataLen.value >= 9) {
        computeUnitPriceMicroLamports = readU64LE(bytes, dataStart + 1);
      } else if (discriminator === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR && dataLen.value >= 5) {
        // u32 LE
        computeUnitLimit =
          bytes[dataStart + 1] |
          (bytes[dataStart + 2] << 8) |
          (bytes[dataStart + 3] << 16) |
          (bytes[dataStart + 4] << 24);
      }
    }

    return {
      numSignatures,
      computeUnitPriceMicroLamports,
      computeUnitLimit,
    };
  } catch {
    return null;
  }
}
