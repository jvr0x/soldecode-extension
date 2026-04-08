import { describe, it, expect } from "vitest";
import {
  parseTransaction,
  readCompactU16,
  readU32LE,
  readU64LE,
  readU64LEBigInt,
  base58Encode,
} from "@/lib/tx-parser";

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 → 32-byte pubkey for test fixture construction. */
function base58Decode(input: string): Uint8Array {
  let num = 0n;
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base58Decode: invalid char ${ch}`);
    num = num * 58n + BigInt(idx);
  }
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

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

/**
 * Builds a synthetic transaction with the given account keys and instructions.
 * Each instruction picks its program by index into accountKeys.
 */
function buildTx(opts: {
  versioned: boolean;
  numSignatures: number;
  accountKeys: Uint8Array[];
  instructions: Array<{ programIdIndex: number; accountIndices: number[]; data: number[] }>;
}): string {
  const bytes: number[] = [];

  writeCompactU16(bytes, opts.numSignatures);
  for (let i = 0; i < opts.numSignatures; i++) {
    for (let b = 0; b < 64; b++) bytes.push(0);
  }

  if (opts.versioned) bytes.push(0x80);

  // Header: numRequiredSigs, numReadonlySigned, numReadonlyUnsigned
  bytes.push(opts.numSignatures, 0, 1);

  writeCompactU16(bytes, opts.accountKeys.length);
  for (const key of opts.accountKeys) {
    for (const b of key) bytes.push(b);
  }

  // Recent blockhash (32 zero bytes)
  for (let i = 0; i < 32; i++) bytes.push(0);

  writeCompactU16(bytes, opts.instructions.length);
  for (const inst of opts.instructions) {
    bytes.push(inst.programIdIndex);
    writeCompactU16(bytes, inst.accountIndices.length);
    for (const idx of inst.accountIndices) bytes.push(idx);
    writeCompactU16(bytes, inst.data.length);
    for (const b of inst.data) bytes.push(b);
  }

  return bytesToBase64(new Uint8Array(bytes));
}

describe("base58Encode", () => {
  it("round-trips a known pubkey", () => {
    const decoded = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
    expect(base58Encode(decoded)).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  });

  it("preserves leading zero bytes as '1' chars", () => {
    const allZero = new Uint8Array(32);
    expect(base58Encode(allZero)).toBe("1".repeat(32));
  });
});

describe("readU32LE / readU64LE / readU64LEBigInt", () => {
  it("readU32LE decodes a 4-byte little-endian unsigned int", () => {
    expect(readU32LE(new Uint8Array([0x01, 0x02, 0x03, 0x04]), 0)).toBe(0x04030201);
  });

  it("readU64LE handles values within JS Number safe range", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
    expect(readU64LE(bytes, 0)).toBe(0xffffffff);
  });

  it("readU64LEBigInt preserves precision for u64::MAX", () => {
    const max = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readU64LEBigInt(max, 0)).toBe((1n << 64n) - 1n);
  });
});

describe("parseTransaction", () => {
  it("parses a legacy tx with two account keys and one instruction", () => {
    const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const cb = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
    const tx = buildTx({
      versioned: false,
      numSignatures: 1,
      accountKeys: [feePayer, cb],
      instructions: [{ programIdIndex: 1, accountIndices: [], data: [3, 0, 0, 0, 0, 0, 0, 0, 0] }],
    });

    const parsed = parseTransaction(tx);
    expect(parsed).not.toBeNull();
    expect(parsed!.numSignatures).toBe(1);
    expect(parsed!.versioned).toBe(false);
    expect(parsed!.accountKeys).toHaveLength(2);
    expect(parsed!.accountKeys[1]).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(parsed!.instructions).toHaveLength(1);
    expect(parsed!.instructions[0].programId).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  });

  it("recognizes the v0 version prefix", () => {
    const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const tx = buildTx({
      versioned: true,
      numSignatures: 1,
      accountKeys: [feePayer],
      instructions: [],
    });

    const parsed = parseTransaction(tx);
    expect(parsed).not.toBeNull();
    expect(parsed!.versioned).toBe(true);
  });

  it("resolves account indices into pubkey strings on each instruction", () => {
    const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const tokenProg = base58Decode(TOKEN_PROGRAM_ID);
    const dummyAcc = base58Decode("4s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const tx = buildTx({
      versioned: true,
      numSignatures: 1,
      accountKeys: [feePayer, tokenProg, dummyAcc],
      // Token Program CloseAccount: data=[9], accounts=[2 (closed), 0 (destination), 0 (authority)]
      instructions: [{ programIdIndex: 1, accountIndices: [2, 0, 0], data: [9] }],
    });

    const parsed = parseTransaction(tx);
    expect(parsed).not.toBeNull();
    const inst = parsed!.instructions[0];
    expect(inst.programId).toBe(TOKEN_PROGRAM_ID);
    expect(inst.accountIndices).toEqual([2, 0, 0]);
    expect(inst.accounts).toHaveLength(3);
    // accounts[1] should resolve to feePayer (account index 0)
    expect(inst.accounts[1]).toBe("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
  });

  it("preserves instruction data byte-for-byte", () => {
    const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const cb = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
    const tx = buildTx({
      versioned: true,
      numSignatures: 1,
      accountKeys: [feePayer, cb],
      // SetComputeUnitPrice with µLamports = 50000 = [0x50, 0xc3, 0, 0, 0, 0, 0, 0]
      instructions: [
        { programIdIndex: 1, accountIndices: [], data: [3, 0x50, 0xc3, 0, 0, 0, 0, 0, 0] },
      ],
    });

    const parsed = parseTransaction(tx);
    expect(parsed!.instructions[0].data).toEqual(
      new Uint8Array([3, 0x50, 0xc3, 0, 0, 0, 0, 0, 0]),
    );
  });

  it("returns null on completely invalid base64", () => {
    expect(parseTransaction("!!!not-base64!!!")).toBeNull();
  });

  it("returns null when bytes are truncated mid-account-key", () => {
    // Build a tx then chop off the trailing bytes.
    const tx = buildTx({
      versioned: true,
      numSignatures: 1,
      accountKeys: [base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN")],
      instructions: [],
    });
    const truncated = tx.slice(0, Math.floor(tx.length / 2));
    expect(parseTransaction(truncated)).toBeNull();
  });

  it("parses multiple instructions in order", () => {
    const feePayer = base58Decode("3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN");
    const cb = base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
    const tokenProg = base58Decode(TOKEN_PROGRAM_ID);
    const tx = buildTx({
      versioned: true,
      numSignatures: 1,
      accountKeys: [feePayer, cb, tokenProg],
      instructions: [
        // SetComputeUnitLimit
        { programIdIndex: 1, accountIndices: [], data: [2, 0xa0, 0x86, 0x01, 0x00] },
        // SetComputeUnitPrice
        { programIdIndex: 1, accountIndices: [], data: [3, 0x50, 0xc3, 0, 0, 0, 0, 0, 0] },
        // Token Transfer (just the discriminator + 8 bytes amount)
        { programIdIndex: 2, accountIndices: [0, 0, 0], data: [3, 0x64, 0, 0, 0, 0, 0, 0, 0] },
      ],
    });

    const parsed = parseTransaction(tx)!;
    expect(parsed.instructions).toHaveLength(3);
    expect(parsed.instructions[0].programId).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(parsed.instructions[1].programId).toBe(COMPUTE_BUDGET_PROGRAM_ID);
    expect(parsed.instructions[2].programId).toBe(TOKEN_PROGRAM_ID);
  });
});

describe("readCompactU16", () => {
  it("decodes single-byte values", () => {
    expect(readCompactU16(new Uint8Array([0]), 0).value).toBe(0);
    expect(readCompactU16(new Uint8Array([127]), 0).value).toBe(127);
  });

  it("decodes two-byte values", () => {
    expect(readCompactU16(new Uint8Array([0xff, 0x7f]), 0).value).toBe(16383);
  });

  it("decodes three-byte values up to u16 max", () => {
    expect(readCompactU16(new Uint8Array([0xff, 0xff, 0x03]), 0).value).toBe(65535);
  });
});
