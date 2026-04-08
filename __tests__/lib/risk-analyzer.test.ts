import { describe, it, expect } from "vitest";
import { analyzeRisks } from "@/lib/risk-analyzer";
import type {
  SimulationResult,
  BalanceChange,
  ParsedTransaction,
  ParsedInstruction,
} from "@/types";
import type { TxFeeInputs } from "@/lib/fee-calculator";

const USER_PUBKEY = "3s4vqy2GvwvnHYLMp8MNMwo3mRnqJWGrWXwJBywxLyKN";
const ATTACKER_PUBKEY = "AttackerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";

/** Default zero priority-fee inputs used by most cases. */
const ZERO_FEE_INPUTS: TxFeeInputs = {
  numSignatures: 1,
  computeUnitPriceMicroLamports: 0,
  computeUnitLimit: null,
};

/** Builds an empty simulation result with the given balances. */
function makeSim(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    err: null,
    logs: [],
    preBalances: [1_000_000_000],
    postBalances: [1_000_000_000],
    preTokenBalances: [],
    postTokenBalances: [],
    unitsConsumed: 5000,
    innerInstructions: [],
    ...overrides,
  };
}

/** Builds a stub ParsedTransaction with the given instructions. */
function makeParsed(instructions: ParsedInstruction[] = [], accountKeys: string[] = [USER_PUBKEY]): ParsedTransaction {
  return {
    numSignatures: 1,
    accountKeys,
    instructions,
    versioned: false,
  };
}

/** Builds a Token Program instruction with the given discriminator and data. */
function tokenInstruction(
  discriminator: number,
  payload: number[],
  accounts: string[] = [],
): ParsedInstruction {
  return {
    programIdIndex: 0,
    programId: TOKEN_PROGRAM,
    accountIndices: [],
    accounts,
    data: new Uint8Array([discriminator, ...payload]),
  };
}

/** Builds a Stake Program instruction with the given 4-byte LE discriminator. */
function stakeInstruction(discriminator: number): ParsedInstruction {
  return {
    programIdIndex: 0,
    programId: STAKE_PROGRAM,
    accountIndices: [],
    accounts: [],
    data: new Uint8Array([
      discriminator & 0xff,
      (discriminator >> 8) & 0xff,
      (discriminator >> 16) & 0xff,
      (discriminator >> 24) & 0xff,
    ]),
  };
}

/** Eight-byte little-endian u64::MAX (0xFF * 8). */
const U64_MAX_BYTES = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

describe("analyzeRisks — baseline", () => {
  it("returns SAFE for an empty tx with no balance changes", () => {
    const { risk, warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(risk).toBe("SAFE");
    expect(warnings).toEqual([]);
  });

  it("warns on high-value SOL outflows above 10 SOL", () => {
    const balanceChanges: BalanceChange[] = [
      { mint: SOL_MINT, symbol: "SOL", name: "Solana", amount: -15, decimals: 9, logoURI: null },
    ];
    const { risk, warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(risk).toBe("WARNING");
    expect(warnings.some((w) => w.title.toLowerCase().includes("high value"))).toBe(true);
  });

  it("does not warn on SOL outflow below the high-value threshold", () => {
    const balanceChanges: BalanceChange[] = [
      { mint: SOL_MINT, symbol: "SOL", name: "Solana", amount: -5, decimals: 9, logoURI: null },
    ];
    const { risk } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(risk).toBe("SAFE");
  });
});

describe("detectUnlimitedApproval", () => {
  it("flags an SPL Approve with u64::MAX amount", () => {
    const inst = tokenInstruction(4, U64_MAX_BYTES);
    const { risk, warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(risk).toBe("WARNING");
    expect(warnings[0].title).toContain("Unlimited");
    expect(warnings[0].severity).toBe("critical");
  });

  it("flags an ApproveChecked with u64::MAX amount", () => {
    const inst = tokenInstruction(13, [...U64_MAX_BYTES, 6]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Unlimited"))).toBe(true);
  });

  it("does not flag an Approve for a finite amount", () => {
    // Approve 100 tokens — encoded as u64 LE = [0x64, 0, 0, 0, 0, 0, 0, 0]
    const inst = tokenInstruction(4, [0x64, 0, 0, 0, 0, 0, 0, 0]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Unlimited"))).toBe(false);
  });
});

describe("detectAccountOwnerHijack", () => {
  it("flags SetAuthority changing AccountOwner with a new authority", () => {
    // SetAuthority discriminator=6, authority_type=2 (AccountOwner), option=1, then 32 bytes pubkey
    const data = [2, 1, ...new Array(32).fill(0xab)];
    const inst = tokenInstruction(6, data);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Ownership"))).toBe(true);
  });

  it("does not flag SetAuthority for non-owner authority types", () => {
    // authority_type=3 (CloseAccount) — handled by mint-authority detector as warning, not hijack.
    const data = [3, 0];
    const inst = tokenInstruction(6, data);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Ownership"))).toBe(false);
  });
});

describe("detectMintAuthorityChange", () => {
  it("flags MintTokens authority changes as critical", () => {
    const data = [0, 0]; // authority_type=0 (MintTokens), option=0 (revoke)
    const inst = tokenInstruction(6, data);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    const mintWarning = warnings.find((w) => w.title.includes("Mint"));
    expect(mintWarning).toBeDefined();
    expect(mintWarning!.severity).toBe("critical");
  });

  it("flags FreezeAccount authority changes", () => {
    const data = [1, 0]; // authority_type=1 (FreezeAccount)
    const inst = tokenInstruction(6, data);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Freeze"))).toBe(true);
  });
});

describe("detectCloseAccountToOther", () => {
  it("flags CloseAccount when destination is not the user", () => {
    const inst = tokenInstruction(9, [], [
      "SomeTokenAccount",
      ATTACKER_PUBKEY,
      USER_PUBKEY,
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Foreign"))).toBe(true);
  });

  it("does not flag CloseAccount when destination is the user", () => {
    const inst = tokenInstruction(9, [], [
      "SomeTokenAccount",
      USER_PUBKEY,
      USER_PUBKEY,
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Foreign"))).toBe(false);
  });
});

describe("detectDrainHeuristic", () => {
  it("flags a 95%+ token wipe as critical", () => {
    const sim = makeSim({
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: USER_PUBKEY,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: { amount: "1000000000", decimals: 6, uiAmount: 1000, uiAmountString: "1000" },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: USER_PUBKEY,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" },
        },
      ],
    });
    const { warnings } = analyzeRisks(
      sim,
      makeParsed(),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Drain"))).toBe(true);
  });

  it("does not flag a small token outflow", () => {
    const sim = makeSim({
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: USER_PUBKEY,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: { amount: "1000000000", decimals: 6, uiAmount: 1000, uiAmountString: "1000" },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: USER_PUBKEY,
          programId: TOKEN_PROGRAM,
          uiTokenAmount: { amount: "999000000", decimals: 6, uiAmount: 999, uiAmountString: "999" },
        },
      ],
    });
    const { warnings } = analyzeRisks(
      sim,
      makeParsed(),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Drain"))).toBe(false);
  });

  it("flags SOL drain when 95% of a meaningful balance is removed", () => {
    const sim = makeSim({
      preBalances: [5_000_000_000], // 5 SOL
      postBalances: [50_000_000], // 0.05 SOL — 99% wiped
    });
    const { warnings } = analyzeRisks(
      sim,
      makeParsed(),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("SOL Drain"))).toBe(true);
  });

  it("does not flag SOL drain on dust balances (< 0.1 SOL)", () => {
    const sim = makeSim({
      preBalances: [50_000_000], // 0.05 SOL
      postBalances: [0],
    });
    const { warnings } = analyzeRisks(
      sim,
      makeParsed(),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("SOL Drain"))).toBe(false);
  });
});

describe("detectOversizedPriorityFee", () => {
  it("flags priority fees above 0.05 SOL", () => {
    // 1_000_000 µLamports/CU * 100_000_000 CU = 1e14 µLamports = 1e8 lamports = 0.1 SOL
    const feeInputs: TxFeeInputs = {
      numSignatures: 1,
      computeUnitPriceMicroLamports: 1_000_000,
      computeUnitLimit: null,
    };
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [],
      USER_PUBKEY,
      feeInputs,
      100_000_000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Oversized Priority"))).toBe(true);
  });

  it("does not flag normal Jupiter-sized priority fees", () => {
    const feeInputs: TxFeeInputs = {
      numSignatures: 1,
      computeUnitPriceMicroLamports: 50_000,
      computeUnitLimit: null,
    };
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [],
      USER_PUBKEY,
      feeInputs,
      150_000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Oversized Priority"))).toBe(false);
  });
});

describe("detectMultiAssetDrain", () => {
  it("flags transactions sending 3+ distinct tokens out of the wallet", () => {
    const balanceChanges: BalanceChange[] = [
      { mint: "MintA", symbol: "A", name: "A", amount: -10, decimals: 6, logoURI: null },
      { mint: "MintB", symbol: "B", name: "B", amount: -20, decimals: 6, logoURI: null },
      { mint: "MintC", symbol: "C", name: "C", amount: -30, decimals: 6, logoURI: null },
    ];
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Multiple Assets"))).toBe(true);
  });

  it("does not flag a normal 1-token swap", () => {
    const balanceChanges: BalanceChange[] = [
      { mint: "MintA", symbol: "A", name: "A", amount: -10, decimals: 6, logoURI: null },
      { mint: "MintB", symbol: "B", name: "B", amount: 5, decimals: 6, logoURI: null },
    ];
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Multiple Assets"))).toBe(false);
  });
});

describe("detectStakeAuthorize", () => {
  it("flags Stake Program Authorize as critical", () => {
    const inst = stakeInstruction(1);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    const stakeWarning = warnings.find((w) => w.title.includes("Stake"));
    expect(stakeWarning).toBeDefined();
    expect(stakeWarning!.severity).toBe("critical");
  });

  it("flags AuthorizeChecked the same way", () => {
    const inst = stakeInstruction(10);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Stake"))).toBe(true);
  });

  it("does not flag DelegateStake", () => {
    const inst = stakeInstruction(2); // DelegateStake
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      [],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    expect(warnings.some((w) => w.title.includes("Stake"))).toBe(false);
  });
});

describe("warning aggregation", () => {
  it("accumulates multiple distinct warnings", () => {
    const balanceChanges: BalanceChange[] = [
      { mint: SOL_MINT, symbol: "SOL", name: "Solana", amount: -15, decimals: 9, logoURI: null },
    ];
    const inst = tokenInstruction(4, U64_MAX_BYTES);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed([inst]),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
    );
    // Both "Unlimited Token Approval" and "High Value Transaction" should fire.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
