/**
 * Structural risk analyzer for previewed transactions.
 *
 * Walks the parsed instruction list (not regex on logs) to detect concrete
 * malicious patterns commonly seen in Solana wallet drainers and rugs:
 * unlimited token approvals, account-ownership hijacks, mint authority
 * grabs, drain heuristics, oversized priority fees, and more.
 *
 * Each detector is small, single-purpose, and accumulates RiskWarning
 * objects with appropriate severity. The overall risk level escalates
 * to WARNING when any warning fires, except for failed simulations which
 * are flagged as DANGER upstream in `simulation-decoder`.
 */

import type {
  SimulationResult,
  BalanceChange,
  RiskLevel,
  RiskWarning,
  ParsedTransaction,
  ParsedInstruction,
  TokenInfo,
} from "@/types";
import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  STAKE_PROGRAM_ID,
  LAMPORTS_PER_SOL,
  CANONICAL_TOKENS,
} from "./constants";
import type { TxFeeInputs } from "./fee-calculator";
import { readU64LEBigInt } from "./tx-parser";
import { detectStandalonePoisoning } from "./poisoning-detector";

/** SOL outflow threshold above which a transfer is flagged as high-value. */
const HIGH_VALUE_SOL_THRESHOLD = 10;

/** Priority fee in SOL above which we flag a tx as having a suspicious fee. */
const OVERSIZED_PRIORITY_FEE_SOL = 0.05;

/** Fraction of pre-balance considered a "drain" wipe (95%). */
const DRAIN_WIPE_RATIO = 0.95;

/** Minimum number of distinct outgoing tokens to trigger the multi-asset detector. */
const MULTI_ASSET_DRAIN_THRESHOLD = 3;

/** Tokens with USD liquidity below this threshold are flagged as illiquid. */
const LOW_LIQUIDITY_USD_THRESHOLD = 10_000;

/** Tokens with fewer holders than this are flagged as fresh / suspicious. */
const FRESH_TOKEN_HOLDER_THRESHOLD = 100;

/** Outgoing-to-incoming USD ratio that triggers a value-asymmetry warning. */
const VALUE_ASYMMETRY_WARN_RATIO = 2;

/** Outgoing-to-incoming USD ratio that escalates the asymmetry warning to critical. */
const VALUE_ASYMMETRY_CRITICAL_RATIO = 10;

/** Fee dust threshold (SOL) used to ignore fees in the USD asymmetry calculation. */
const SOL_FEE_DUST_FOR_ASYMMETRY = 0.01;

/** u64::MAX — what an "unlimited" SPL token Approve looks like on the wire. */
const U64_MAX = (1n << 64n) - 1n;

/** Token Program instruction discriminators (1 byte each, custom Pack format). */
const TOKEN_IX_TRANSFER = 3;
const TOKEN_IX_APPROVE = 4;
const TOKEN_IX_SET_AUTHORITY = 6;
const TOKEN_IX_CLOSE_ACCOUNT = 9;
const TOKEN_IX_APPROVE_CHECKED = 13;

/** SetAuthority `authority_type` enum values. */
const AUTH_TYPE_MINT_TOKENS = 0;
const AUTH_TYPE_FREEZE_ACCOUNT = 1;
const AUTH_TYPE_ACCOUNT_OWNER = 2;
const AUTH_TYPE_CLOSE_ACCOUNT = 3;

/** Stake Program uses bincode → 4-byte u32 LE enum discriminators. */
const STAKE_IX_AUTHORIZE = 1;
const STAKE_IX_AUTHORIZE_CHECKED = 10;

/** Returns true when an instruction targets one of the SPL Token programs. */
function isTokenProgram(programId: string): boolean {
  return programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID;
}

/**
 * Reads the SPL Token instruction discriminator (always the first byte) and
 * returns it. Returns -1 when the instruction has no data.
 */
function tokenIxDiscriminator(inst: ParsedInstruction): number {
  return inst.data.length > 0 ? inst.data[0] : -1;
}

/**
 * Detects token Approve / ApproveChecked instructions whose amount is
 * `u64::MAX`, which is the canonical "unlimited spending permission"
 * pattern used by drainer phishing kits.
 */
function detectUnlimitedApproval(parsed: ParsedTransaction): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  for (const inst of parsed.instructions) {
    if (!isTokenProgram(inst.programId)) continue;
    const disc = tokenIxDiscriminator(inst);

    let amount: bigint | null = null;
    if (disc === TOKEN_IX_APPROVE && inst.data.length >= 9) {
      amount = readU64LEBigInt(inst.data, 1);
    } else if (disc === TOKEN_IX_APPROVE_CHECKED && inst.data.length >= 9) {
      amount = readU64LEBigInt(inst.data, 1);
    }

    if (amount === U64_MAX) {
      warnings.push({
        severity: "critical",
        title: "Unlimited Token Approval",
        description:
          "This transaction grants a program permission to spend ALL of your tokens, " +
          "now and in the future. If the program is malicious, it can drain this token " +
          "from your wallet at any time. Do not approve unless you fully trust the dApp.",
      });
      // Reason: one warning per tx is enough — multiple Approves to the same delegate are common.
      return warnings;
    }
  }
  return warnings;
}

/**
 * Detects SPL Token SetAuthority instructions that change the AccountOwner —
 * an outright hijack of the user's token account.
 */
function detectAccountOwnerHijack(parsed: ParsedTransaction, userPubkey: string): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  for (const inst of parsed.instructions) {
    if (!isTokenProgram(inst.programId)) continue;
    if (tokenIxDiscriminator(inst) !== TOKEN_IX_SET_AUTHORITY) continue;
    if (inst.data.length < 3) continue;

    const authorityType = inst.data[1];
    if (authorityType !== AUTH_TYPE_ACCOUNT_OWNER) continue;

    // Reason: option byte = 1 means a new authority follows; 0 means revoke.
    // Both are dangerous, but a new pubkey that isn't the user is the worst case.
    const optionPresent = inst.data[2] === 1;
    let newAuthority: string | null = null;
    if (optionPresent && inst.data.length >= 3 + 32) {
      // We don't decode the 32-byte pubkey here — just note it's not the user.
      // The accounts list won't include the new authority (it's data-only),
      // so we conservatively flag any non-revoke ownership change.
      newAuthority = "non-self";
    }

    if (newAuthority !== userPubkey) {
      warnings.push({
        severity: "critical",
        title: "Token Account Ownership Change",
        description:
          "This transaction transfers ownership of one of your token accounts to " +
          "another address. After this, you will no longer control that token account.",
      });
      return warnings;
    }
  }
  return warnings;
}

/**
 * Detects SPL Token SetAuthority instructions that change a mint's
 * MintTokens or FreezeAccount authority. If the user owns a token mint
 * (e.g. they created a memecoin), this can be a rug-pull setup.
 */
function detectMintAuthorityChange(parsed: ParsedTransaction): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  for (const inst of parsed.instructions) {
    if (!isTokenProgram(inst.programId)) continue;
    if (tokenIxDiscriminator(inst) !== TOKEN_IX_SET_AUTHORITY) continue;
    if (inst.data.length < 2) continue;

    const authorityType = inst.data[1];
    if (
      authorityType === AUTH_TYPE_MINT_TOKENS ||
      authorityType === AUTH_TYPE_FREEZE_ACCOUNT
    ) {
      const which = authorityType === AUTH_TYPE_MINT_TOKENS ? "mint" : "freeze";
      warnings.push({
        severity: "critical",
        title: `Token ${which.charAt(0).toUpperCase()}${which.slice(1)} Authority Change`,
        description:
          `This transaction changes the ${which} authority of a token mint. ` +
          `This is a privileged operation — only proceed if you intentionally manage this token.`,
      });
      return warnings;
    }

    if (authorityType === AUTH_TYPE_CLOSE_ACCOUNT) {
      warnings.push({
        severity: "warning",
        title: "Close Authority Change",
        description:
          "This transaction changes who is allowed to close one of your token accounts.",
      });
      return warnings;
    }
  }
  return warnings;
}

/**
 * Detects SPL Token CloseAccount instructions whose rent destination is
 * not the signing user — that is, your account's lamports are being sent
 * to a stranger when the account is closed.
 *
 * The Token Program CloseAccount instruction takes accounts:
 * [0] = account being closed, [1] = destination, [2] = authority.
 */
function detectCloseAccountToOther(
  parsed: ParsedTransaction,
  userPubkey: string,
): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  for (const inst of parsed.instructions) {
    if (!isTokenProgram(inst.programId)) continue;
    if (tokenIxDiscriminator(inst) !== TOKEN_IX_CLOSE_ACCOUNT) continue;
    if (inst.accounts.length < 2) continue;

    const destination = inst.accounts[1];
    if (destination && destination !== userPubkey) {
      warnings.push({
        severity: "warning",
        title: "Account Close to Foreign Address",
        description:
          "This transaction closes one of your token accounts and sends the rent SOL " +
          "to an address that is not your wallet.",
      });
      return warnings;
    }
  }
  return warnings;
}

/**
 * Detects "drain" patterns: any tracked balance change that wipes 95%+
 * of the pre-existing balance. The simulator's pre/post token balances
 * give us the absolute pre-amounts, so we can compute ratios.
 */
function detectDrainHeuristic(
  sim: SimulationResult,
  balanceChanges: BalanceChange[],
  userPubkey: string,
  accountKeys: string[],
): RiskWarning[] {
  const warnings: RiskWarning[] = [];

  // Token-side drains: walk preTokenBalances to find user accounts that
  // either disappear or shrink by >= DRAIN_WIPE_RATIO of their pre-balance.
  for (const pre of sim.preTokenBalances) {
    if (pre.owner !== userPubkey) continue;
    const preAmount = pre.uiTokenAmount.uiAmount ?? 0;
    if (preAmount <= 0) continue;

    const post = sim.postTokenBalances.find(
      (p) =>
        p.owner === userPubkey &&
        p.accountIndex === pre.accountIndex &&
        p.mint === pre.mint,
    );
    const postAmount = post?.uiTokenAmount.uiAmount ?? 0;
    const lostFraction = (preAmount - postAmount) / preAmount;
    if (lostFraction >= DRAIN_WIPE_RATIO) {
      const change = balanceChanges.find((c) => c.mint === pre.mint);
      const symbol = change?.symbol ?? `${pre.mint.slice(0, 4)}...${pre.mint.slice(-4)}`;
      warnings.push({
        severity: "critical",
        title: "Possible Token Drain",
        description: `This transaction would empty ${(lostFraction * 100).toFixed(0)}% of your ${symbol} balance.`,
      });
      // One drain warning is enough; further detail would just be noise.
      return warnings;
    }
  }

  // SOL-side drain: compare pre/post for the user's main account index.
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i] !== userPubkey) continue;
    const pre = sim.preBalances[i] ?? 0;
    const post = sim.postBalances[i] ?? 0;
    if (pre <= 0) continue;
    const lostFraction = (pre - post) / pre;
    // Reason: a 95% wipe of a meaningful SOL balance (>0.1 SOL) is a drain.
    // Below that, account closures and rent moves can hit 100% legitimately.
    if (lostFraction >= DRAIN_WIPE_RATIO && pre / LAMPORTS_PER_SOL >= 0.1) {
      warnings.push({
        severity: "critical",
        title: "Possible SOL Drain",
        description: `This transaction would empty ${(lostFraction * 100).toFixed(0)}% of your SOL balance.`,
      });
      return warnings;
    }
  }

  return warnings;
}

/**
 * Detects oversized priority fees — drainer kits sometimes set absurd
 * compute_unit_price values to silently siphon SOL via fees alone.
 */
function detectOversizedPriorityFee(
  feeInputs: TxFeeInputs,
  unitsConsumed: number,
): RiskWarning[] {
  const priorityLamports = Math.floor(
    (feeInputs.computeUnitPriceMicroLamports * unitsConsumed) / 1_000_000,
  );
  const prioritySol = priorityLamports / LAMPORTS_PER_SOL;
  if (prioritySol >= OVERSIZED_PRIORITY_FEE_SOL) {
    return [
      {
        severity: "warning",
        title: "Oversized Priority Fee",
        description: `This transaction sets a priority fee of ~${prioritySol.toFixed(4)} SOL — far above typical Solana fees. This may be an attempt to drain SOL via the fee mechanism.`,
      },
    ];
  }
  return [];
}

/**
 * Detects when the user is RECEIVING a token whose mint authority is still
 * active. A non-null mint authority means the creator can issue more of the
 * token at any time, diluting holders. Common in legit stablecoins (USDC,
 * USDT) but also a hallmark of pump-and-dump tokens.
 */
function detectActiveMintAuthority(
  balanceChanges: BalanceChange[],
  tokenInfoMap: Map<string, TokenInfo>,
): RiskWarning[] {
  for (const change of balanceChanges) {
    if (change.amount <= 0) continue;
    const info = tokenInfoMap.get(change.mint);
    if (!info || info.mintAuthority === null) continue;
    return [
      {
        severity: "warning",
        title: "Mint Authority Active",
        description: `${info.symbol} has an active mint authority — the creator can issue more tokens at any time, diluting holders.`,
      },
    ];
  }
  return [];
}

/**
 * Detects when the user is RECEIVING a token whose freeze authority is still
 * active. The creator can freeze your token account and prevent you from
 * moving the asset. Used by some compliant stablecoins, but also by scam
 * tokens to lock victims out after a rug.
 */
function detectActiveFreezeAuthority(
  balanceChanges: BalanceChange[],
  tokenInfoMap: Map<string, TokenInfo>,
): RiskWarning[] {
  for (const change of balanceChanges) {
    if (change.amount <= 0) continue;
    const info = tokenInfoMap.get(change.mint);
    if (!info || info.freezeAuthority === null) continue;
    return [
      {
        severity: "warning",
        title: "Freeze Authority Active",
        description: `${info.symbol} has an active freeze authority — the creator can freeze your token account at any time, blocking transfers.`,
      },
    ];
  }
  return [];
}

/**
 * Detects tokens that claim a canonical symbol (USDC, USDT, etc.) but whose
 * mint address doesn't match the real one. Scammers use this pattern to
 * airdrop worthless copycat tokens or swap-output them into user wallets.
 *
 * Uses the hardcoded CANONICAL_TOKENS table as ground truth — the false
 * positive rate on legit tokens claiming a popular symbol is effectively
 * zero for the entries in that table.
 */
function detectImpersonatorToken(balanceChanges: BalanceChange[]): RiskWarning[] {
  for (const change of balanceChanges) {
    if (!change.symbol) continue;
    const symbolKey = change.symbol.toUpperCase();
    const canonicalMint = CANONICAL_TOKENS[symbolKey];
    if (!canonicalMint) continue;
    if (change.mint === canonicalMint) continue;

    return [
      {
        severity: "critical",
        title: "Impersonator Token",
        description:
          `This transaction involves a token using the symbol "${change.symbol}", ` +
          `but its mint address (${change.mint.slice(0, 8)}...${change.mint.slice(-4)}) ` +
          `does not match the canonical ${symbolKey} mint. This is a common scam — ` +
          `worthless copycat tokens are airdropped or swap-output into wallets to ` +
          `trick users into thinking they received the real thing.`,
      },
    ];
  }
  return [];
}

/**
 * Detects when the user is RECEIVING a token with USD liquidity below
 * a threshold — meaning they may not be able to sell it back. Classic
 * honeypot setup.
 */
function detectLowLiquidity(
  balanceChanges: BalanceChange[],
  tokenInfoMap: Map<string, TokenInfo>,
): RiskWarning[] {
  for (const change of balanceChanges) {
    if (change.amount <= 0) continue;
    const info = tokenInfoMap.get(change.mint);
    if (!info || info.liquidity === null) continue;
    if (info.liquidity < LOW_LIQUIDITY_USD_THRESHOLD) {
      return [
        {
          severity: "critical",
          title: "Low Liquidity Token",
          description: `${info.symbol} has only $${info.liquidity.toFixed(0)} of liquidity across DEXes. You may not be able to sell it back. This is a common honeypot pattern.`,
        },
      ];
    }
  }
  return [];
}

/**
 * Detects when the user is RECEIVING a token with very few holders, or
 * a token that isn't indexed by Jupiter at all. Either is a strong signal
 * the token is fresh, untested, or possibly a scam.
 */
function detectFreshOrUnknownToken(
  balanceChanges: BalanceChange[],
  tokenInfoMap: Map<string, TokenInfo>,
): RiskWarning[] {
  for (const change of balanceChanges) {
    if (change.amount <= 0) continue;
    if (change.mint === SOL_MINT) continue;

    const info = tokenInfoMap.get(change.mint);
    // Reason: when Jupiter has no metadata at all, the cache returns the
    // shortened-mint fallback with name === "Unknown Token". Treat that as a
    // strong "fresh / untrusted" signal.
    if (!info || info.name === "Unknown Token") {
      return [
        {
          severity: "warning",
          title: "Unknown Token",
          description: `Receiving a token (${change.mint.slice(0, 4)}...${change.mint.slice(-4)}) that isn't indexed by Jupiter. This often means the token is fresh, untraded, or a scam.`,
        },
      ];
    }
    if (info.holderCount !== null && info.holderCount < FRESH_TOKEN_HOLDER_THRESHOLD) {
      return [
        {
          severity: "warning",
          title: "Fresh Token",
          description: `${info.symbol} has only ${info.holderCount} holders. Tokens with very few holders are usually freshly minted and high-risk.`,
        },
      ];
    }
  }
  return [];
}

/**
 * Detects USD-value asymmetry between outgoing and incoming tokens. When
 * a tx sends out far more value than it brings in, the user is being
 * scammed (or signed a tx with crazy slippage).
 *
 * Filters SOL fee dust out of both sides so a small SOL fee doesn't get
 * misread as the swap input.
 */
function detectUsdValueAsymmetry(
  balanceChanges: BalanceChange[],
  tokenInfoMap: Map<string, TokenInfo>,
): RiskWarning[] {
  let outUsd = 0;
  let inUsd = 0;
  let pricedAny = false;

  for (const change of balanceChanges) {
    if (
      change.mint === SOL_MINT &&
      Math.abs(change.amount) < SOL_FEE_DUST_FOR_ASYMMETRY
    ) {
      continue;
    }
    const info = tokenInfoMap.get(change.mint);
    if (!info || info.usdPrice === null || info.usdPrice <= 0) continue;
    pricedAny = true;
    const usd = Math.abs(change.amount) * info.usdPrice;
    if (change.amount < 0) outUsd += usd;
    else inUsd += usd;
  }

  // Reason: if we couldn't price either side, asymmetry is meaningless.
  if (!pricedAny || outUsd === 0 || inUsd === 0) return [];
  const ratio = outUsd / inUsd;
  if (ratio < VALUE_ASYMMETRY_WARN_RATIO) return [];

  const severity: RiskWarning["severity"] =
    ratio >= VALUE_ASYMMETRY_CRITICAL_RATIO ? "critical" : "warning";
  return [
    {
      severity,
      title: severity === "critical" ? "Severe Value Loss" : "Value Asymmetry",
      description: `This transaction sends ~$${outUsd.toFixed(2)} of value out of your wallet but brings only ~$${inUsd.toFixed(2)} back in (${ratio.toFixed(1)}× asymmetry). Verify the swap rate is what you expect.`,
    },
  ];
}

/** Detects high-value outgoing SOL transfers exceeding the threshold. */
function detectHighValue(balanceChanges: BalanceChange[]): RiskWarning[] {
  const solChange = balanceChanges.find((c) => c.mint === SOL_MINT);
  if (solChange && solChange.amount < -HIGH_VALUE_SOL_THRESHOLD) {
    return [
      {
        severity: "warning",
        title: "High Value Transaction",
        description: `This transaction will send ${Math.abs(solChange.amount).toFixed(2)} SOL from your wallet. Make sure this is intended.`,
      },
    ];
  }
  return [];
}

/**
 * Detects incoming sub-dust SOL transfers commonly used in address-poisoning
 * attacks, airdrop-based wallet profiling, and drainer bait.
 *
 * Converts the incoming SOL amount to lamports and delegates to
 * `detectStandalonePoisoning` from the poisoning-detector module.
 * Only fires on positive (incoming) SOL balance changes; outgoing amounts
 * are ignored even when sub-dust.
 */
function detectDustSolReceipt(balanceChanges: BalanceChange[]): RiskWarning[] {
  const solChange = balanceChanges.find(
    (c) => c.mint === SOL_MINT && c.amount > 0,
  );
  if (!solChange) return [];

  const lamports = solChange.amount * LAMPORTS_PER_SOL;
  const result = detectStandalonePoisoning(lamports);
  if (!result.detected) return [];

  const baseDescription =
    result.warning ??
    "This looks like a sub-dust SOL deposit that may be used for address poisoning or wallet profiling. Do not copy the sender's address.";
  const description = `${baseDescription} Amount: ${solChange.amount.toFixed(9).replace(/\.?0+$/, "")} SOL.`;

  return [
    {
      severity: "warning",
      title: "Sub-Dust Incoming Transfer",
      description,
    },
  ];
}

/**
 * Detects transactions that move ≥ MULTI_ASSET_DRAIN_THRESHOLD distinct
 * tokens out of the user's wallet at once — a classic drainer signature.
 */
function detectMultiAssetDrain(balanceChanges: BalanceChange[]): RiskWarning[] {
  const distinctOutgoing = new Set<string>();
  for (const c of balanceChanges) {
    if (c.amount < 0) distinctOutgoing.add(c.mint);
  }
  if (distinctOutgoing.size >= MULTI_ASSET_DRAIN_THRESHOLD) {
    return [
      {
        severity: "critical",
        title: "Multiple Assets Leaving Wallet",
        description: `This transaction sends ${distinctOutgoing.size} different tokens out of your wallet at once. This is a common pattern for wallet drainer attacks.`,
      },
    ];
  }
  return [];
}

/**
 * Detects Stake Program Authorize / AuthorizeChecked instructions, which
 * transfer either staking or withdrawal authority over a stake account.
 *
 * Stake Program uses bincode encoding → 4-byte u32 LE enum discriminator.
 */
function detectStakeAuthorize(parsed: ParsedTransaction): RiskWarning[] {
  for (const inst of parsed.instructions) {
    if (inst.programId !== STAKE_PROGRAM_ID) continue;
    if (inst.data.length < 4) continue;
    const disc =
      inst.data[0] |
      (inst.data[1] << 8) |
      (inst.data[2] << 16) |
      (inst.data[3] * 0x1000000);
    if (disc === STAKE_IX_AUTHORIZE || disc === STAKE_IX_AUTHORIZE_CHECKED) {
      return [
        {
          severity: "critical",
          title: "Stake Authority Change",
          description:
            "This transaction transfers staking or withdrawal authority over a stake " +
            "account to another address. The new authority can move your staked SOL.",
        },
      ];
    }
  }
  return [];
}

/**
 * Runs the full risk analyzer suite over a parsed transaction and returns
 * the aggregated warnings plus an overall risk level.
 *
 * @param sim - Raw simulation result.
 * @param parsed - Parsed transaction (for instruction-level detectors).
 * @param balanceChanges - Diffed user-facing balance changes.
 * @param userPubkey - The wallet address whose perspective we're analyzing.
 * @param feeInputs - Compute budget settings parsed from the tx (for fee-based detectors).
 * @param unitsConsumed - CU consumed by the simulation (for fee-based detectors).
 * @param accountKeys - Ordered account keys (for SOL-side drain detection).
 * @param tokenInfoMap - Resolved TokenInfo for every mint in balanceChanges.
 *                       Powers the metadata-driven detectors (mint authority,
 *                       freeze authority, liquidity, holder count, USD asymmetry).
 */
export function analyzeRisks(
  sim: SimulationResult,
  parsed: ParsedTransaction,
  balanceChanges: BalanceChange[],
  userPubkey: string,
  feeInputs: TxFeeInputs,
  unitsConsumed: number,
  accountKeys: string[],
  tokenInfoMap: Map<string, TokenInfo>,
): { risk: RiskLevel; warnings: RiskWarning[] } {
  const warnings: RiskWarning[] = [];

  // Instruction-level structural detectors.
  warnings.push(...detectUnlimitedApproval(parsed));
  warnings.push(...detectAccountOwnerHijack(parsed, userPubkey));
  warnings.push(...detectMintAuthorityChange(parsed));
  warnings.push(...detectCloseAccountToOther(parsed, userPubkey));
  warnings.push(...detectStakeAuthorize(parsed));

  // Balance-side detectors.
  warnings.push(...detectDrainHeuristic(sim, balanceChanges, userPubkey, accountKeys));
  warnings.push(...detectMultiAssetDrain(balanceChanges));
  warnings.push(...detectHighValue(balanceChanges));
  warnings.push(...detectDustSolReceipt(balanceChanges));

  // Fee-side detectors.
  warnings.push(...detectOversizedPriorityFee(feeInputs, unitsConsumed));

  // Token-metadata-driven detectors (Phase A + B).
  warnings.push(...detectActiveMintAuthority(balanceChanges, tokenInfoMap));
  warnings.push(...detectActiveFreezeAuthority(balanceChanges, tokenInfoMap));
  warnings.push(...detectLowLiquidity(balanceChanges, tokenInfoMap));
  warnings.push(...detectFreshOrUnknownToken(balanceChanges, tokenInfoMap));
  warnings.push(...detectImpersonatorToken(balanceChanges));
  warnings.push(...detectUsdValueAsymmetry(balanceChanges, tokenInfoMap));

  // Reason: any warning escalates risk to WARNING; DANGER is reserved for failed sims.
  const risk: RiskLevel = warnings.length > 0 ? "WARNING" : "SAFE";
  return { risk, warnings };
}
