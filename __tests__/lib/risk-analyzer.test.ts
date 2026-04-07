import { describe, it, expect } from "vitest";
import { analyzeRisks } from "@/lib/risk-analyzer";
import type { SimulationResult, BalanceChange } from "@/types";

/** Base sim result used across tests — contains a token approval sequence. */
const approvalSimResult: SimulationResult = {
  err: null,
  logs: [
    "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
    "Program log: Instruction: Approve",
    "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
  ],
  preBalances: [1_000_000_000],
  postBalances: [1_000_000_000],
  preTokenBalances: [],
  postTokenBalances: [],
  unitsConsumed: 5000,
  innerInstructions: [],
};

describe("analyzeRisks", () => {
  it("returns SAFE for normal transactions", () => {
    const sim: SimulationResult = {
      ...approvalSimResult,
      logs: [
        "Program 11111111111111111111111111111111 invoke [1]",
        "Program 11111111111111111111111111111111 success",
      ],
    };
    const { risk, warnings } = analyzeRisks(sim, []);
    expect(risk).toBe("SAFE");
    expect(warnings.length).toBe(0);
  });

  it("warns on token approval in logs", () => {
    const { risk, warnings } = analyzeRisks(approvalSimResult, []);
    expect(risk).toBe("WARNING");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].title).toContain("Approval");
  });

  it("warns on high-value SOL outgoing (> 10 SOL)", () => {
    const balanceChanges: BalanceChange[] = [
      {
        mint: "So11111111111111111111111111111111111111112",
        symbol: "SOL",
        name: "Solana",
        amount: -15,
        decimals: 9,
        logoURI: null,
      },
    ];
    const sim: SimulationResult = { ...approvalSimResult, logs: [] };
    const { risk, warnings } = analyzeRisks(sim, balanceChanges);
    expect(risk).toBe("WARNING");
    expect(warnings.some((w) => w.title.toLowerCase().includes("high value"))).toBe(true);
  });

  it("does not warn on SOL outgoing below threshold (< 10 SOL)", () => {
    const balanceChanges: BalanceChange[] = [
      {
        mint: "So11111111111111111111111111111111111111112",
        symbol: "SOL",
        name: "Solana",
        amount: -5,
        decimals: 9,
        logoURI: null,
      },
    ];
    const sim: SimulationResult = { ...approvalSimResult, logs: [] };
    const { risk, warnings } = analyzeRisks(sim, balanceChanges);
    expect(risk).toBe("SAFE");
    expect(warnings.length).toBe(0);
  });

  it("accumulates multiple warnings", () => {
    const balanceChanges: BalanceChange[] = [
      {
        mint: "So11111111111111111111111111111111111111112",
        symbol: "SOL",
        name: "Solana",
        amount: -15,
        decimals: 9,
        logoURI: null,
      },
    ];
    const { risk, warnings } = analyzeRisks(approvalSimResult, balanceChanges);
    expect(risk).toBe("WARNING");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
