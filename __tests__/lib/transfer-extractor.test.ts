import { describe, it, expect } from "vitest";
import { extractOutgoingDestinations } from "@/lib/transfer-extractor";
import type { ParsedTransaction, ParsedInstruction } from "@/types";

const USER_PUBKEY = "3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN";
const RECIPIENT_A = "RecipientAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECIPIENT_B = "RecipientBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Builds a minimal ParsedTransaction with the given instructions. */
function makeParsed(
  instructions: ParsedInstruction[],
  accountKeys: string[] = [USER_PUBKEY],
): ParsedTransaction {
  return {
    numSignatures: 1,
    accountKeys,
    instructions,
    versioned: false,
  };
}

/** Builds a System Program Transfer instruction (disc u32 LE = 2). */
function systemTransfer(from: string, to: string): ParsedInstruction {
  return {
    programIdIndex: 0,
    programId: SYSTEM_PROGRAM_ID,
    accountIndices: [],
    accounts: [from, to],
    data: new Uint8Array([0x02, 0x00, 0x00, 0x00]),
  };
}

/** Builds an SPL Token Transfer instruction (first byte = 3, dest at accounts[1]). */
function tokenTransfer(
  src: string,
  dst: string,
  programId = TOKEN_PROGRAM_ID,
): ParsedInstruction {
  return {
    programIdIndex: 0,
    programId,
    accountIndices: [],
    accounts: [src, dst],
    data: new Uint8Array([3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  };
}

/** Builds an SPL Token TransferChecked instruction (first byte = 12, dest at accounts[2]). */
function tokenTransferChecked(
  src: string,
  mint: string,
  dst: string,
  authority: string,
  programId = TOKEN_PROGRAM_ID,
): ParsedInstruction {
  return {
    programIdIndex: 0,
    programId,
    accountIndices: [],
    accounts: [src, mint, dst, authority],
    data: new Uint8Array([12, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 6]),
  };
}

describe("extractOutgoingDestinations", () => {
  it("extracts the destination of a System Program Transfer (accounts[1])", () => {
    const inst = systemTransfer(USER_PUBKEY, RECIPIENT_A);
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([RECIPIENT_A]);
  });

  it("extracts the destination of an SPL Token Transfer (accounts[1])", () => {
    const MINT = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const inst = tokenTransfer(USER_PUBKEY, RECIPIENT_A);
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([RECIPIENT_A]);
  });

  it("extracts the destination of an SPL Token TransferChecked (accounts[2], not accounts[1])", () => {
    const MINT = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    // accounts[1] is the mint — we must pick accounts[2] as destination.
    const inst = tokenTransferChecked(USER_PUBKEY, MINT, RECIPIENT_A, USER_PUBKEY);
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([RECIPIENT_A]);
    // Verify the mint address was NOT returned.
    expect(result).not.toContain(MINT);
  });

  it("filters out self-transfers (destination === userPubkey)", () => {
    // A transfer where the destination is the user themselves (e.g. consolidation).
    const inst = systemTransfer(USER_PUBKEY, USER_PUBKEY);
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([]);
  });

  it("deduplicates when multiple instructions target the same destination", () => {
    const inst1 = systemTransfer(USER_PUBKEY, RECIPIENT_A);
    const inst2 = tokenTransfer(USER_PUBKEY, RECIPIENT_A);
    const result = extractOutgoingDestinations(makeParsed([inst1, inst2]), USER_PUBKEY);
    // Both instructions hit RECIPIENT_A — dedup should produce a single entry.
    expect(result).toEqual([RECIPIENT_A]);
  });

  it("returns an empty array when the parsed tx has no transfer instructions", () => {
    // An instruction with an unrecognized program id produces no destinations.
    const inst: ParsedInstruction = {
      programIdIndex: 0,
      programId: "ComputeBudget111111111111111111111111111111",
      accountIndices: [],
      accounts: [],
      data: new Uint8Array([0x03, 0x00, 0x00, 0x00]),
    };
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([]);
  });

  it("handles Token-2022 Transfer the same as the legacy Token Program", () => {
    const inst = tokenTransfer(USER_PUBKEY, RECIPIENT_B, TOKEN_2022_PROGRAM_ID);
    const result = extractOutgoingDestinations(makeParsed([inst]), USER_PUBKEY);
    expect(result).toEqual([RECIPIENT_B]);
  });

  it("collects multiple distinct destinations across mixed instruction types", () => {
    const MINT = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const inst1 = systemTransfer(USER_PUBKEY, RECIPIENT_A);
    const inst2 = tokenTransferChecked(USER_PUBKEY, MINT, RECIPIENT_B, USER_PUBKEY);
    const result = extractOutgoingDestinations(makeParsed([inst1, inst2]), USER_PUBKEY);
    expect(result).toHaveLength(2);
    expect(result).toContain(RECIPIENT_A);
    expect(result).toContain(RECIPIENT_B);
  });
});
