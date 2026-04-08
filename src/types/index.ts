/** Risk level for a previewed transaction. */
export type RiskLevel = "SAFE" | "WARNING" | "DANGER";

/** A single balance change from simulation. */
export interface BalanceChange {
  /** Token mint address (SOL_MINT for native SOL). */
  mint: string;
  /** Token symbol. */
  symbol: string;
  /** Token name. */
  name: string;
  /** Change amount (negative = outgoing, positive = incoming). Already decimal-adjusted. */
  amount: number;
  /** Number of decimals for this token. */
  decimals: number;
  /** Token logo URL. */
  logoURI: string | null;
}

/** A risk warning to display to the user. */
export interface RiskWarning {
  /** Warning severity. */
  severity: "critical" | "warning" | "info";
  /** Short title. */
  title: string;
  /** Detailed explanation. */
  description: string;
}

/** A single step in what the transaction will do. */
export interface PreviewStep {
  /** Step number (1-based). */
  index: number;
  /** Human-readable description. */
  description: string;
  /** Program that executes this step. */
  program?: string;
}

/** Error explanation with fix suggestions. */
export interface ErrorExplanation {
  /** Human-readable title. */
  title: string;
  /** Plain-English reason. */
  reason: string;
  /** Actionable fix suggestions. */
  fixes: string[];
  /** Raw error for advanced users. */
  rawError: string;
}

/** Token metadata, enriched with the risk-relevant fields the Jupiter v2 search endpoint returns. */
export interface TokenInfo {
  /** Mint address. */
  address: string;
  /** Symbol (e.g., "SOL"). */
  symbol: string;
  /** Name (e.g., "Solana"). */
  name: string;
  /** Decimal places. */
  decimals: number;
  /** Logo URL. */
  logoURI: string | null;
  /**
   * Mint authority pubkey, or null if renounced. A non-null value means
   * the creator can still mint more of this token at any time.
   */
  mintAuthority: string | null;
  /**
   * Freeze authority pubkey, or null if renounced. A non-null value means
   * the creator can freeze your token account, blocking transfers.
   */
  freezeAuthority: string | null;
  /** Number of holders, when known. Used as a freshness/scam signal. */
  holderCount: number | null;
  /** USD-denominated liquidity depth across DEXes, when known. */
  liquidity: number | null;
  /** Market cap in USD, when known. */
  mcap: number | null;
  /** Spot USD price per whole token, when known. */
  usdPrice: number | null;
}

/** The full simulation preview — the core data structure. */
export interface SimulatedPreview {
  /** Overall risk assessment. */
  risk: RiskLevel;
  /** One-line plain-English summary. */
  summary: string;
  /** Balance changes for the user's wallet. */
  balanceChanges: BalanceChange[];
  /** Plain-English bullets shown under "What Will Happen". */
  plainSteps: string[];
  /** Technical instruction breakdown shown under "Instructions". */
  steps: PreviewStep[];
  /** Risk warnings (empty if SAFE). */
  warnings: RiskWarning[];
  /** Error explanation (if simulation failed). */
  error?: ErrorExplanation;
  /** Estimated fee in SOL. */
  estimatedFee: number;
  /** Compute units consumed. */
  computeUnits: number;
  /** The dApp origin URL. */
  origin: string;
}

/** Raw simulateTransaction RPC response value. */
export interface SimulationResult {
  /** Error if simulation failed. */
  err: unknown;
  /** Program logs. */
  logs: string[] | null;
  /** Pre-execution SOL balances (lamports) per account index. */
  preBalances: number[];
  /** Post-execution SOL balances (lamports) per account index. */
  postBalances: number[];
  /** Pre-execution token balances. */
  preTokenBalances: TokenBalance[];
  /** Post-execution token balances. */
  postTokenBalances: TokenBalance[];
  /** Compute units consumed. */
  unitsConsumed: number;
  /** Inner instructions (CPI calls). */
  innerInstructions: unknown[];
}

/** Token balance entry from simulation response. */
export interface TokenBalance {
  /** Account index in the transaction's account list. */
  accountIndex: number;
  /** Token mint address. */
  mint: string;
  /** Owner of the token account. */
  owner: string;
  /** Program ID (Token Program or Token-2022). */
  programId: string;
  /** Human-readable amount info. */
  uiTokenAmount: {
    /** Raw amount as string. */
    amount: string;
    /** Decimal places. */
    decimals: number;
    /** Decimal-adjusted amount. */
    uiAmount: number | null;
    /** Decimal-adjusted amount as string. */
    uiAmountString: string;
  };
}

/** Address poisoning detection result. */
export interface PoisoningResult {
  /** Whether poisoning was detected. */
  detected: boolean;
  /** The suspicious sender address. */
  suspiciousAddress?: string;
  /** The real contact address it mimics. */
  realContactAddress?: string;
  /** Human-readable warning message. */
  warning?: string;
}

/** Extension settings stored in chrome.storage.local. */
export interface ExtensionSettings {
  /** Whether the extension is enabled. */
  enabled: boolean;
  /** Helius RPC endpoint URL (includes API key). */
  rpcEndpoint: string;
}

/**
 * One top-level instruction from a parsed Solana transaction message.
 * Inner CPI calls are not represented here — those only show up in logs.
 */
export interface ParsedInstruction {
  /** Index of the program in `ParsedTransaction.accountKeys`. */
  programIdIndex: number;
  /** Resolved program ID (base58). */
  programId: string;
  /** Account indices into `ParsedTransaction.accountKeys`. */
  accountIndices: number[];
  /** Resolved account keys (parallel to accountIndices) for convenience. */
  accounts: string[];
  /** Raw instruction data bytes. */
  data: Uint8Array;
}

/**
 * Structurally parsed Solana transaction. The shared output of tx-parser
 * that fee-calculator and risk-analyzer both consume so the message bytes
 * are walked exactly once per simulation.
 */
export interface ParsedTransaction {
  /** Number of required signatures from the top-level shortvec. */
  numSignatures: number;
  /** Account keys in message order (signers first, then writable, then readonly). */
  accountKeys: string[];
  /** Top-level instructions, in order. */
  instructions: ParsedInstruction[];
  /** True for versioned (v0) transactions, false for legacy. */
  versioned: boolean;
}
