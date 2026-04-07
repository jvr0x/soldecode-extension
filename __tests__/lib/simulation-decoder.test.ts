import { describe, it, expect, vi } from "vitest";
import { decodeSimulation } from "@/lib/simulation-decoder";
import type { SimulationResult } from "@/types";

// Mock token-cache to avoid network calls in tests.
vi.mock("@/lib/token-cache", () => ({
  getTokenInfo: vi.fn(async (mint: string) => {
    const tokens: Record<
      string,
      { address: string; symbol: string; name: string; decimals: number; logoURI: null }
    > = {
      So11111111111111111111111111111111111111112: {
        address: "So11111111111111111111111111111111111111112",
        symbol: "SOL",
        name: "Solana",
        decimals: 9,
        logoURI: null,
      },
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        logoURI: null,
      },
    };
    return (
      tokens[mint] ?? {
        address: mint,
        symbol: "???",
        name: "Unknown",
        decimals: 9,
        logoURI: null,
      }
    );
  }),
}));

const USER_PUBKEY = "3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN";

/** Simulates a SOL → USDC swap: 2.5 SOL out, 142.3 USDC in. */
const makeSwapSimResult = (): SimulationResult => ({
  err: null,
  logs: [
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
    "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [2]",
    "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success",
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
  ],
  preBalances: [5_000_000_000, 1_000_000, 0],
  postBalances: [2_500_000_000, 1_000_000, 0],
  preTokenBalances: [],
  postTokenBalances: [
    {
      accountIndex: 2,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      owner: USER_PUBKEY,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      uiTokenAmount: {
        amount: "142300000",
        decimals: 6,
        uiAmount: 142.3,
        uiAmountString: "142.3",
      },
    },
  ],
  unitsConsumed: 150000,
  innerInstructions: [],
});

/** Simulates a failed transaction (Jupiter slippage error). */
const makeFailedSimResult = (): SimulationResult => ({
  err: { InstructionError: [2, { Custom: 6001 }] },
  logs: [
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
    "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771",
  ],
  preBalances: [5_000_000_000],
  postBalances: [5_000_000_000],
  preTokenBalances: [],
  postTokenBalances: [],
  unitsConsumed: 50000,
  innerInstructions: [],
});

describe("decodeSimulation", () => {
  it("decodes a successful swap simulation", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"],
      "https://jup.ag",
    );

    expect(result.risk).toBe("SAFE");
    expect(result.balanceChanges.length).toBeGreaterThan(0);

    const solChange = result.balanceChanges.find((c) => c.symbol === "SOL");
    expect(solChange).toBeDefined();
    expect(solChange!.amount).toBeCloseTo(-2.5);

    const usdcChange = result.balanceChanges.find((c) => c.symbol === "USDC");
    expect(usdcChange).toBeDefined();
    expect(usdcChange!.amount).toBeCloseTo(142.3);

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
    expect(result.estimatedFee).toBeGreaterThan(0);
  });

  it("decodes a failed simulation with error explanation", async () => {
    const result = await decodeSimulation(
      makeFailedSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY],
      "https://jup.ag",
    );

    expect(result.risk).toBe("DANGER");
    expect(result.error).toBeDefined();
    expect(result.error!.title).toBe("Slippage Exceeded");
  });

  it("includes compute units", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"],
      "https://jup.ag",
    );
    expect(result.computeUnits).toBe(150000);
  });

  it("sets origin correctly", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"],
      "https://jup.ag",
    );
    expect(result.origin).toBe("https://jup.ag");
  });

  it("ignores balance changes for accounts other than userPubkey", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"],
      "https://jup.ag",
    );
    // ProgramAccount1 balance is unchanged (1_000_000 → 1_000_000), should not appear
    const programChange = result.balanceChanges.find(
      (c) => c.symbol === "SOL" && c.amount === 0,
    );
    expect(programChange).toBeUndefined();
  });

  it("produces a summary string for a swap", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      USER_PUBKEY,
      [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"],
      "https://jup.ag",
    );
    expect(result.summary).toMatch(/swap/i);
  });
});
