/**
 * Solana transaction message parser.
 *
 * Walks the binary message format once and produces a ParsedTransaction
 * containing the signature count, all account keys, and every top-level
 * instruction. Both `fee-calculator` (compute-budget instructions) and
 * `risk-analyzer` (Token Program / Stake Program instructions) consume
 * this output so we don't reparse the same bytes twice per simulation.
 *
 * Handles legacy and versioned (v0) transactions. v0 introduced the 0x80
 * version prefix and address-lookup-table sections after the instructions;
 * we ignore the lookup tables for now (loaded addresses don't appear in
 * top-level instructions, only in inner CPI calls visible via logs).
 */

import type { ParsedInstruction, ParsedTransaction } from "@/types";

/** Base58 alphabet used by Solana for pubkey encoding. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Reads a Solana compact-u16 ("shortvec") starting at `offset`.
 * Returns the decoded value and the number of bytes consumed (1, 2, or 3).
 *
 * Format: each byte uses 7 bits of value; the high bit signals "more bytes".
 * Max representable value is 65535 (u16 max), achieved with all 3 bytes.
 */
export function readCompactU16(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
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
  throw new Error("readCompactU16: continuation past 3 bytes");
}

/** Encodes a 32-byte pubkey to base58. */
export function base58Encode(bytes: Uint8Array): string {
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
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parses a base64-encoded Solana transaction.
 * Returns null on any parse failure so callers can fall back gracefully
 * instead of throwing into the simulation pipeline.
 */
export function parseTransaction(base64Tx: string): ParsedTransaction | null {
  try {
    const bytes = base64ToBytes(base64Tx);
    let offset = 0;

    // Signatures section
    const sigsHeader = readCompactU16(bytes, offset);
    const numSignatures = sigsHeader.value;
    offset += sigsHeader.bytesRead + numSignatures * 64;

    // Versioned tx prefix
    let versioned = false;
    if (bytes[offset] === 0x80) {
      versioned = true;
      offset += 1;
    }

    // Message header (3 bytes)
    offset += 3;

    // Account keys
    const accountsHeader = readCompactU16(bytes, offset);
    const numAccounts = accountsHeader.value;
    offset += accountsHeader.bytesRead;

    const accountKeys: string[] = [];
    for (let i = 0; i < numAccounts; i++) {
      if (offset + 32 > bytes.length) return null;
      accountKeys.push(base58Encode(bytes.slice(offset, offset + 32)));
      offset += 32;
    }

    // Recent blockhash (32 bytes)
    offset += 32;

    // Instructions
    const instructionsHeader = readCompactU16(bytes, offset);
    const numInstructions = instructionsHeader.value;
    offset += instructionsHeader.bytesRead;

    const instructions: ParsedInstruction[] = [];
    for (let i = 0; i < numInstructions; i++) {
      const programIdIndex = bytes[offset];
      offset += 1;

      const accountsLen = readCompactU16(bytes, offset);
      offset += accountsLen.bytesRead;
      const accountIndices: number[] = [];
      for (let j = 0; j < accountsLen.value; j++) {
        accountIndices.push(bytes[offset + j]);
      }
      offset += accountsLen.value;

      const dataLen = readCompactU16(bytes, offset);
      offset += dataLen.bytesRead;
      const data = bytes.slice(offset, offset + dataLen.value);
      offset += dataLen.value;

      const programId = accountKeys[programIdIndex] ?? "";
      const accounts = accountIndices.map((idx) => accountKeys[idx] ?? "");

      instructions.push({
        programIdIndex,
        programId,
        accountIndices,
        accounts,
        data,
      });
    }

    return {
      numSignatures,
      accountKeys,
      instructions,
      versioned,
    };
  } catch {
    return null;
  }
}

/** Convenience: reads a little-endian u32 from `bytes` at `offset`. */
export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  );
}

/**
 * Reads a little-endian u64 from `bytes` and returns it as a JS number.
 * Values above 2^53 lose precision but the use cases here (token amounts,
 * compute unit prices) all fit comfortably.
 */
export function readU64LE(bytes: Uint8Array, offset: number): number {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return Number(result);
}

/**
 * Reads a little-endian u64 as a BigInt — used when the caller needs to
 * compare against u64::MAX without losing precision.
 */
export function readU64LEBigInt(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return result;
}
