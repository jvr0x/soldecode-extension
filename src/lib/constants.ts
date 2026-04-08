import type { TokenInfo } from "@/types";

/** Native SOL mint address (wrapped SOL). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Dust threshold for poisoning detection (lamports). */
export const DUST_THRESHOLD_LAMPORTS = 1_000_000;

/** Characters to compare for address poisoning. */
export const POISONING_MATCH_CHARS = 4;

/** Max u64 — used to detect unlimited token approvals. */
export const MAX_U64 = "18446744073709551615";

/**
 * SOL changes smaller than this are treated as fees / ATA rent rather than
 * the actual asset being moved. Used by the swap-summary heuristic so a
 * "1 USDC → cbBTC" swap isn't summarized as "Swap 0.002 SOL for 0.000014 cbBTC".
 * 0.01 SOL comfortably exceeds typical Jupiter swap costs (~0.002–0.005 SOL).
 */
export const SOL_FEE_DUST_THRESHOLD = 0.01;

/** Token Program address. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Token-2022 Program address. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Stake Program address. */
export const STAKE_PROGRAM_ID = "Stake11111111111111111111111111111111111111";

/** Associated Token Account program — its presence means an ATA is being created. */
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Maps swap venue program IDs to short user-facing names. Used by the
 * plain-English step generator to phrase swap actions like "via Jupiter".
 */
export const SWAP_VENUE_NAMES: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX7rE: "Jupiter",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "Pump.fun",
};

/** Known program names for display. */
export const KNOWN_PROGRAMS: Record<string, string> = {
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX7rE": "Jupiter v4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "Pump.fun AMM",
  "11111111111111111111111111111111": "System Program",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token Program",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "Token-2022",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token Program",
  "ComputeBudget111111111111111111111111111111": "Compute Budget",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr": "Memo Program",
};

/** Default Helius RPC endpoint (user provides their own key). */
export const DEFAULT_RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=";

/** SOL token info for display. Used as the fallback when network lookups fail. */
export const SOL_TOKEN: TokenInfo = {
  address: SOL_MINT,
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  logoURI: null,
  // Reason: SOL has no mint/freeze authority and is the canonical safe asset.
  mintAuthority: null,
  freezeAuthority: null,
  holderCount: null,
  liquidity: null,
  mcap: null,
  usdPrice: null,
};
