import { describe, it, expect } from "vitest";
import {
  calculateFeeSol,
  parseTxFeeInputs,
  readCompactU16,
  BASE_LAMPORTS_PER_SIGNATURE,
} from "@/lib/fee-calculator";

/** Compute Budget program ID — same constant as the production module. */
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/**
 * Decodes a base58 string into the raw 32-byte public key. Used by the test
 * fixture builder so we don't have to hand-encode mints byte-for-byte.
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  let num = 0n;
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base58Decode: invalid char ${ch}`);
    num = num * 58n + BigInt(idx);
  }
  // Reason: Solana addresses always serialize to 32 bytes, even when
  // BigInt's natural representation is shorter. Front-pad with zeros.
  const out: number[] = [];
  while (num > 0n) {
    out.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of input) {
    if (ch === "1") out.unshift(0);
    else break;
  }
  while (out.length < 32) out.unshift(0);
  return new Uint8Array(out);
}

/** Encodes bytes to base64 without depending on Buffer (matches inject.ts). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Writes a Solana compact-u16 (shortvec) into the buffer at the given offset. */
function writeCompactU16(out: number[], value: number): void {
  let v = value;
  while (true) {
    if (v < 0x80) {
      out.push(v);
      return;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

/** Writes a 32-bit little-endian unsigned integer. */
function writeU32LE(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Writes a 64-bit little-endian unsigned integer. JS Number is sufficient for our test values. */
function writeU64LE(out: number[], value: number): void {
  let big = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out.push(Number(big & 0xffn));
    big >>= 8n;
  }
}

/**
 * Builds a base64 transaction fixture with the requested compute budget
 * settings. The fee payer is a dummy non-zero pubkey; everything else is
 * minimal but structurally valid.
 *
 * @param opts.versioned   - Emit a v0 versioned tx (with the 0x80 prefix).
 * @param opts.numSignatures - Number of signature placeholders to emit.
 * @param opts.priceMicroLamports - Compute unit price (omit to skip the instruction).
 * @param opts.unitLimit   - Compute unit limit (omit to skip the instruction).
 */
function buildTxFixture(opts: {
  versioned: boolean;
  numSignatures: number;
  priceMicroLamports?: number;
  unitLimit?: number;
}): string {
  const bytes: number[] = [];

  // Signatures: compact-u16 count, then 64 zero bytes per sig.
  writeCompactU16(bytes, opts.numSignatures);
  for (let i = 0; i < opts.numSignatures; i++) {
    for (let b = 0; b < 64; b++) bytes.push(0);
  }

  // Versioned prefix.
  if (opts.versioned) bytes.push(0x80);

  // Message header (numRequiredSigs, numReadonlySigned, numReadonlyUnsigned).
  bytes.push(opts.numSignatures, 0, 1);

  // Account keys: fee payer (random non-zero) + Compute Budget program.
  const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
  const computeBudget = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
  writeCompactU16(bytes, 2);
  for (const b of feePayer) bytes.push(b);
  for (const b of computeBudget) bytes.push(b);

  // Recent blockhash (32 zero bytes — sigVerify=false anyway).
  for (let i = 0; i < 32; i++) bytes.push(0);

  // Build instruction list.
  const instructions: Array<{ programIdIndex: number; data: number[] }> = [];
  if (opts.unitLimit !== undefined) {
    const data: number[] = [2]; // SetComputeUnitLimit discriminator
    writeU32LE(data, opts.unitLimit);
    instructions.push({ programIdIndex: 1, data });
  }
  if (opts.priceMicroLamports !== undefined) {
    const data: number[] = [3]; // SetComputeUnitPrice discriminator
    writeU64LE(data, opts.priceMicroLamports);
    instructions.push({ programIdIndex: 1, data });
  }

  writeCompactU16(bytes, instructions.length);
  for (const inst of instructions) {
    bytes.push(inst.programIdIndex);
    writeCompactU16(bytes, 0); // 0 account indices
    writeCompactU16(bytes, inst.data.length);
    for (const b of inst.data) bytes.push(b);
  }

  return bytesToBase64(new Uint8Array(bytes));
}

describe("readCompactU16", () => {
  it("decodes a single-byte value", () => {
    const r = readCompactU16(new Uint8Array([42]), 0);
    expect(r.value).toBe(42);
    expect(r.bytesRead).toBe(1);
  });

  it("decodes a two-byte value", () => {
    // 200 = 0xC8 = 0b11001000 → encoded as [0xC8, 0x01]
    const r = readCompactU16(new Uint8Array([0xc8, 0x01]), 0);
    expect(r.value).toBe(200);
    expect(r.bytesRead).toBe(2);
  });

  it("decodes the max two-byte value (16383)", () => {
    // 16383 = 0x3FFF — uses 14 bits, fits in 2 shortvec bytes.
    const r = readCompactU16(new Uint8Array([0xff, 0x7f]), 0);
    expect(r.value).toBe(16383);
    expect(r.bytesRead).toBe(2);
  });

  it("decodes the max three-byte value (65535)", () => {
    // u16 max = 0xFFFF — needs all 3 shortvec bytes.
    const r = readCompactU16(new Uint8Array([0xff, 0xff, 0x03]), 0);
    expect(r.value).toBe(65535);
    expect(r.bytesRead).toBe(3);
  });

  it("respects offset", () => {
    const r = readCompactU16(new Uint8Array([0xff, 0xff, 5]), 2);
    expect(r.value).toBe(5);
    expect(r.bytesRead).toBe(1);
  });

  it("throws on continuation past 3 bytes", () => {
    expect(() => readCompactU16(new Uint8Array([0x80, 0x80, 0x80, 0x01]), 0)).toThrow();
  });
});

describe("calculateFeeSol", () => {
  it("returns base fee only when no priority fee is set", () => {
    const fee = calculateFeeSol(
      { numSignatures: 1, computeUnitPriceMicroLamports: 0, computeUnitLimit: null },
      150_000,
    );
    expect(fee).toBe(BASE_LAMPORTS_PER_SIGNATURE / 1_000_000_000);
    expect(fee).toBeCloseTo(0.000005, 9);
  });

  it("multiplies base fee by signature count", () => {
    const fee = calculateFeeSol(
      { numSignatures: 3, computeUnitPriceMicroLamports: 0, computeUnitLimit: null },
      150_000,
    );
    expect(fee).toBeCloseTo(0.000015, 9);
  });

  it("adds priority fee from compute unit price", () => {
    // 1_000_000 µLamports/CU * 200_000 CU = 2e11 µLamports = 200_000 lamports priority fee.
    // Plus 1 sig base = 5_000 lamports. Total = 205_000 lamports = 0.000205 SOL.
    const fee = calculateFeeSol(
      { numSignatures: 1, computeUnitPriceMicroLamports: 1_000_000, computeUnitLimit: null },
      200_000,
    );
    expect(fee).toBeCloseTo(0.000205, 9);
  });

  it("floors priority fee to whole lamports", () => {
    // 7 µLamports/CU * 100 CU = 700 µLamports = 0 lamports (floored).
    const fee = calculateFeeSol(
      { numSignatures: 1, computeUnitPriceMicroLamports: 7, computeUnitLimit: null },
      100,
    );
    expect(fee).toBeCloseTo(0.000005, 9);
  });

  it("matches the production Jupiter swap range", () => {
    // Real Jupiter swap: ~1 sig, ~50_000 µLamports/CU, ~150_000 CU consumed.
    // Priority = 50_000 * 150_000 / 1e6 = 7_500 lamports
    // Base = 5_000 lamports
    // Total = 12_500 lamports = 0.0000125 SOL — vastly higher than the old 0.00015 SOL fictional number.
    const fee = calculateFeeSol(
      { numSignatures: 1, computeUnitPriceMicroLamports: 50_000, computeUnitLimit: 200_000 },
      150_000,
    );
    expect(fee).toBeCloseTo(0.0000125, 9);
  });
});

describe("parseTxFeeInputs", () => {
  it("parses a legacy tx with no compute budget instructions", () => {
    const tx = buildTxFixture({ versioned: false, numSignatures: 1 });
    const inputs = parseTxFeeInputs(tx);
    expect(inputs).not.toBeNull();
    expect(inputs!.numSignatures).toBe(1);
    expect(inputs!.computeUnitPriceMicroLamports).toBe(0);
    expect(inputs!.computeUnitLimit).toBeNull();
  });

  it("parses a versioned tx with SetComputeUnitPrice", () => {
    const tx = buildTxFixture({
      versioned: true,
      numSignatures: 1,
      priceMicroLamports: 50_000,
    });
    const inputs = parseTxFeeInputs(tx);
    expect(inputs).not.toBeNull();
    expect(inputs!.numSignatures).toBe(1);
    expect(inputs!.computeUnitPriceMicroLamports).toBe(50_000);
  });

  it("parses both SetComputeUnitLimit and SetComputeUnitPrice", () => {
    const tx = buildTxFixture({
      versioned: true,
      numSignatures: 1,
      priceMicroLamports: 1_000_000,
      unitLimit: 200_000,
    });
    const inputs = parseTxFeeInputs(tx);
    expect(inputs).not.toBeNull();
    expect(inputs!.computeUnitPriceMicroLamports).toBe(1_000_000);
    expect(inputs!.computeUnitLimit).toBe(200_000);
  });

  it("captures multi-signature transactions", () => {
    const tx = buildTxFixture({ versioned: false, numSignatures: 2 });
    const inputs = parseTxFeeInputs(tx);
    expect(inputs).not.toBeNull();
    expect(inputs!.numSignatures).toBe(2);
  });

  it("returns null on garbage input instead of throwing", () => {
    expect(parseTxFeeInputs("not-base64-and-not-a-tx!!")).toBeNull();
  });

  it("end-to-end: parsed inputs feed into calculateFeeSol correctly", () => {
    const tx = buildTxFixture({
      versioned: true,
      numSignatures: 1,
      priceMicroLamports: 100_000,
      unitLimit: 300_000,
    });
    const inputs = parseTxFeeInputs(tx)!;
    const fee = calculateFeeSol(inputs, 280_000);
    // base 5_000 + priority floor(100_000 * 280_000 / 1e6) = 5_000 + 28_000 = 33_000 lamports
    expect(fee).toBeCloseTo(33_000 / 1_000_000_000, 9);
  });
});
