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

/** Default account-keys list used by the swap fixture above. */
const SWAP_ACCOUNT_KEYS = [USER_PUBKEY, "ProgramAccount1", "TokenAccount1"];

/** Minimal stub ParsedTransaction wrapping the swap account keys with no instructions. */
const SWAP_PARSED = {
  numSignatures: 1,
  accountKeys: SWAP_ACCOUNT_KEYS,
  instructions: [],
  versioned: false,
};

/** Stub ParsedTransaction for the failed-tx fixture (single account). */
const SINGLE_ACCOUNT_PARSED = {
  numSignatures: 1,
  accountKeys: [USER_PUBKEY],
  instructions: [],
  versioned: false,
};

/** Stable estimated fee passed by service-worker in production; tests use a fixed value. */
const FIXED_FEE = 0.0000125;

describe("decodeSimulation", () => {
  it("decodes a successful swap simulation", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
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
  });

  it("uses the caller-provided estimatedFee verbatim", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      0.0042,
    );
    expect(result.estimatedFee).toBe(0.0042);
  });

  it("decodes a failed simulation with error explanation", async () => {
    const result = await decodeSimulation(
      makeFailedSimResult(),
      SINGLE_ACCOUNT_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );

    expect(result.risk).toBe("DANGER");
    expect(result.error).toBeDefined();
    expect(result.error!.title).toBe("Slippage Exceeded");
  });

  it("includes compute units", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.computeUnits).toBe(150000);
  });

  it("sets origin correctly", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.origin).toBe("https://jup.ag");
  });

  it("ignores balance changes for accounts other than userPubkey", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
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
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.summary).toMatch(/swap/i);
  });

  it("ignores small SOL fee dust when picking the swap from-asset", async () => {
    // Reproduces the bug from a real Jupiter screenshot: SOL fee of -0.002
    // (dust) should NOT be picked as the swap's "from" asset over the
    // larger USDC outflow.
    const sim = makeSwapSimResult();
    // Override balances so SOL change is small (-0.002 SOL = -2_000_000 lamports)
    // and USDC is the actual token being spent.
    sim.preBalances = [5_000_000_000, 1_000_000, 0];
    sim.postBalances = [4_998_000_000, 1_000_000, 0];
    sim.preTokenBalances = [
      {
        accountIndex: 2,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        owner: USER_PUBKEY,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: "1000000", decimals: 6, uiAmount: 1, uiAmountString: "1" },
      },
    ];
    sim.postTokenBalances = [
      {
        accountIndex: 2,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        owner: USER_PUBKEY,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" },
      },
    ];

    const result = await decodeSimulation(
      sim,
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );

    // The summary should mention USDC, not SOL, as the asset being spent.
    expect(result.summary).toContain("USDC");
    expect(result.summary).not.toMatch(/0\.00\d+ SOL/);
  });

  it("populates plainSteps with at least one bullet", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.plainSteps.length).toBeGreaterThan(0);
  });

  it("plainSteps describes a swap when both outgoing and incoming are present", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    const swapStep = result.plainSteps.find((s) => /swap/i.test(s));
    expect(swapStep).toBeDefined();
    // Reason: detectSwapVenue should pick up Jupiter from the logs.
    expect(swapStep!).toMatch(/Jupiter/i);
  });

  it("plainSteps reports SOL fees & rent line when SOL outflow is significant", async () => {
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    const feeStep = result.plainSteps.find((s) => /SOL/.test(s) && /fee/i.test(s));
    expect(feeStep).toBeDefined();
  });

  it("plainSteps shows a single failure line on failed simulations", async () => {
    const result = await decodeSimulation(
      makeFailedSimResult(),
      SINGLE_ACCOUNT_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.plainSteps.length).toBe(1);
    expect(result.plainSteps[0]).toMatch(/fail/i);
  });

  it("summary trims trailing zeros from amounts", async () => {
    // Sanity check that 142.3 doesn't render as 142.300000.
    const result = await decodeSimulation(
      makeSwapSimResult(),
      SWAP_PARSED,
      USER_PUBKEY,
      "https://jup.ag",
      FIXED_FEE,
    );
    expect(result.summary).toContain("142.3 USDC");
    expect(result.summary).not.toContain("142.300000");
  });
});
