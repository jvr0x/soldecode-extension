import { describe, it, expect } from "vitest";
import { analyzeRisks } from "@/lib/risk-analyzer";
import type {
  SimulationResult,
  BalanceChange,
  ParsedTransaction,
  ParsedInstruction,
  TokenInfo,
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

/** Empty token info map — used by structural-detector tests that don't need metadata. */
const EMPTY_INFO_MAP = new Map<string, TokenInfo>();

/**
 * Builds a TokenInfo with the given overrides — defaults are "boring legit
 * token" so individual fields can be flipped to a risky value per test.
 */
function makeTokenInfo(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: overrides.address ?? "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    symbol: "TKN",
    name: "Token",
    decimals: 6,
    logoURI: null,
    mintAuthority: null,
    freezeAuthority: null,
    holderCount: 5000,
    liquidity: 1_000_000,
    mcap: 100_000_000,
    usdPrice: 1,
    ...overrides,
  };
}

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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
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
      EMPTY_INFO_MAP,
    );
    expect(warnings.some((w) => w.title.includes("Stake"))).toBe(false);
  });
});

describe("detectActiveMintAuthority", () => {
  it("warns when receiving a token with an active mint authority", () => {
    const mint = "MintWithAuth111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "RUG", name: "Rug Token", amount: 1000, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, symbol: "RUG", mintAuthority: "AnyAuthorityXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Mint Authority Active"))).toBe(true);
  });

  it("does not warn when the mint authority is null", () => {
    const mint = "RenouncedMint111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "OK", name: "Renounced", amount: 100, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, mintAuthority: null })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Mint Authority Active"))).toBe(false);
  });

  it("ignores tokens the user is sending out", () => {
    // Sending a mint-authority-active token away is not the user's risk; receiving it is.
    const mint = "MintWithAuth111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "RUG", name: "Rug Token", amount: -100, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, mintAuthority: "Auth" })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Mint Authority Active"))).toBe(false);
  });
});

describe("detectActiveFreezeAuthority", () => {
  it("warns when receiving a token with an active freeze authority", () => {
    const mint = "FreezeMint11111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "FRZ", name: "Freeze Token", amount: 50, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, symbol: "FRZ", freezeAuthority: "FreezerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Freeze Authority Active"))).toBe(true);
  });

  it("does not warn when freeze authority is null", () => {
    const mint = "NoFreeze1111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "OK", name: "OK", amount: 50, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, freezeAuthority: null })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Freeze Authority Active"))).toBe(false);
  });
});

describe("detectLowLiquidity", () => {
  it("flags tokens with liquidity below the threshold as critical", () => {
    const mint = "LowLiq11111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "DUST", name: "Dust", amount: 1, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, liquidity: 500 })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    const warning = warnings.find((w) => w.title.includes("Low Liquidity"));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("critical");
  });

  it("does not flag tokens with healthy liquidity", () => {
    const mint = "BigLiq11111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "BIG", name: "Big", amount: 1, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, liquidity: 5_000_000 })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Low Liquidity"))).toBe(false);
  });

  it("skips when liquidity field is unknown", () => {
    const mint = "Unknown111111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "X", name: "X", amount: 1, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, liquidity: null })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Low Liquidity"))).toBe(false);
  });
});

describe("detectFreshOrUnknownToken", () => {
  it("warns on tokens with very few holders", () => {
    const mint = "Fresh111111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "FRESH", name: "Fresh", amount: 1000, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, holderCount: 12 })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Fresh Token"))).toBe(true);
  });

  it("warns on tokens not indexed by Jupiter at all", () => {
    const mint = "Unknown111111111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "Unkn...n111", name: "Unknown Token", amount: 1, decimals: 9, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, name: "Unknown Token", holderCount: null })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Unknown Token"))).toBe(true);
  });

  it("does not warn on well-established tokens", () => {
    const mint = "Established11111111111111111111111111111111";
    const change: BalanceChange = {
      mint, symbol: "OK", name: "Established", amount: 100, decimals: 6, logoURI: null,
    };
    const map = new Map([[mint, makeTokenInfo({ address: mint, name: "Established", holderCount: 100_000 })]]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      [change],
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Fresh Token") || w.title.includes("Unknown Token"))).toBe(false);
  });
});

describe("detectUsdValueAsymmetry", () => {
  it("warns when outflow exceeds inflow by 2x", () => {
    const mintOut = "OutMint11111111111111111111111111111111111";
    const mintIn = "InMint111111111111111111111111111111111111";
    const balanceChanges: BalanceChange[] = [
      { mint: mintOut, symbol: "USDC", name: "USDC", amount: -100, decimals: 6, logoURI: null },
      { mint: mintIn, symbol: "SCAM", name: "Scam", amount: 30, decimals: 6, logoURI: null },
    ];
    const map = new Map([
      [mintOut, makeTokenInfo({ address: mintOut, usdPrice: 1 })],
      [mintIn, makeTokenInfo({ address: mintIn, usdPrice: 1 })],
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    const w = warnings.find((x) => x.title.includes("Asymmetry") || x.title.includes("Severe Value"));
    expect(w).toBeDefined();
  });

  it("escalates to critical when outflow > 10x inflow", () => {
    const mintOut = "OutMint11111111111111111111111111111111111";
    const mintIn = "InMint111111111111111111111111111111111111";
    const balanceChanges: BalanceChange[] = [
      { mint: mintOut, symbol: "USDC", name: "USDC", amount: -100, decimals: 6, logoURI: null },
      { mint: mintIn, symbol: "DUST", name: "Dust", amount: 5, decimals: 6, logoURI: null },
    ];
    const map = new Map([
      [mintOut, makeTokenInfo({ address: mintOut, usdPrice: 1 })],
      [mintIn, makeTokenInfo({ address: mintIn, usdPrice: 1 })],
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    const critical = warnings.find((w) => w.severity === "critical" && w.title.includes("Severe Value"));
    expect(critical).toBeDefined();
  });

  it("does not warn on a fair-priced swap with small slippage", () => {
    const mintOut = "OutMint11111111111111111111111111111111111";
    const mintIn = "InMint111111111111111111111111111111111111";
    const balanceChanges: BalanceChange[] = [
      { mint: mintOut, symbol: "USDC", name: "USDC", amount: -100, decimals: 6, logoURI: null },
      { mint: mintIn, symbol: "SOL", name: "SOL", amount: 1, decimals: 9, logoURI: null },
    ];
    const map = new Map([
      [mintOut, makeTokenInfo({ address: mintOut, usdPrice: 1 })],
      [mintIn, makeTokenInfo({ address: mintIn, usdPrice: 99 })],
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Asymmetry") || w.title.includes("Severe Value"))).toBe(false);
  });

  it("ignores SOL fee dust when computing the asymmetry ratio", () => {
    // SOL change is just a tiny fee, not the actual swap input — should not break the calc.
    const mintOut = "OutMint11111111111111111111111111111111111";
    const mintIn = "InMint111111111111111111111111111111111111";
    const balanceChanges: BalanceChange[] = [
      { mint: SOL_MINT, symbol: "SOL", name: "SOL", amount: -0.002, decimals: 9, logoURI: null },
      { mint: mintOut, symbol: "USDC", name: "USDC", amount: -100, decimals: 6, logoURI: null },
      { mint: mintIn, symbol: "BTC", name: "BTC", amount: 0.0014, decimals: 8, logoURI: null },
    ];
    const map = new Map([
      [SOL_MINT, makeTokenInfo({ address: SOL_MINT, usdPrice: 100 })],
      [mintOut, makeTokenInfo({ address: mintOut, usdPrice: 1 })],
      [mintIn, makeTokenInfo({ address: mintIn, usdPrice: 70_000 })],
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    // 100 USDC out vs 0.0014 * 70000 = $98 in → ratio ~1.02, no warning.
    expect(warnings.some((w) => w.title.includes("Asymmetry") || w.title.includes("Severe Value"))).toBe(false);
  });

  it("skips silently when neither side can be priced", () => {
    const mintOut = "OutMint11111111111111111111111111111111111";
    const mintIn = "InMint111111111111111111111111111111111111";
    const balanceChanges: BalanceChange[] = [
      { mint: mintOut, symbol: "X", name: "X", amount: -100, decimals: 6, logoURI: null },
      { mint: mintIn, symbol: "Y", name: "Y", amount: 50, decimals: 6, logoURI: null },
    ];
    const map = new Map([
      [mintOut, makeTokenInfo({ address: mintOut, usdPrice: null })],
      [mintIn, makeTokenInfo({ address: mintIn, usdPrice: null })],
    ]);
    const { warnings } = analyzeRisks(
      makeSim(),
      makeParsed(),
      balanceChanges,
      USER_PUBKEY,
      ZERO_FEE_INPUTS,
      5000,
      [USER_PUBKEY],
      map,
    );
    expect(warnings.some((w) => w.title.includes("Asymmetry") || w.title.includes("Severe Value"))).toBe(false);
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
      EMPTY_INFO_MAP,
    );
    // Both "Unlimited Token Approval" and "High Value Transaction" should fire.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
