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

/** Token metadata. */
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
