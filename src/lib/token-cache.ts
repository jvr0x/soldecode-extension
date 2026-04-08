import type { TokenInfo } from "@/types";
import { SOL_TOKEN } from "./constants";

/** Jupiter lite-api per-token search endpoint. Takes a mint in `query`. */
const JUPITER_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";

/** How long a cached lookup stays fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Shape of a single entry in the cache (value + timestamp for TTL). */
interface CachedEntry {
  /** Resolved token info, or null if the mint was not found upstream. */
  info: TokenInfo | null;
  /** When this entry was written, in ms since epoch. */
  fetchedAt: number;
}

/** Relevant subset of the Jupiter /tokens/v2/search response object. */
interface JupiterSearchToken {
  /** Mint address. */
  id: string;
  /** Token name. */
  name: string;
  /** Ticker symbol. */
  symbol: string;
  /** Decimal places. */
  decimals: number;
  /** Logo URL (new field name in v2). */
  icon?: string;
}

/** In-memory cache keyed by mint. Survives within a service worker lifetime. */
const memoryCache = new Map<string, CachedEntry>();

/** In-flight fetch promises keyed by mint — deduplicates concurrent lookups. */
const inFlight = new Map<string, Promise<TokenInfo | null>>();

/** Storage key used for persisted cache entries. */
const STORAGE_KEY = "tokenCacheV2";

/** Whether the in-memory cache has been hydrated from chrome.storage yet. */
let hydrated = false;

/** Hydrates `memoryCache` from chrome.storage.local on first use. */
async function hydrateFromStorage(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const stored = data[STORAGE_KEY] as Record<string, CachedEntry> | undefined;
    if (!stored) return;
    for (const [mint, entry] of Object.entries(stored)) {
      memoryCache.set(mint, entry);
    }
  } catch {
    /* Reason: falling back to an empty cache is always safe. */
  }
}

/** Persists the current in-memory cache to chrome.storage.local. */
async function persistToStorage(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const serializable: Record<string, CachedEntry> = {};
    for (const [mint, entry] of memoryCache) {
      serializable[mint] = entry;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: serializable });
  } catch {
    /* Reason: persistence is best-effort; memory cache still works. */
  }
}

/** Returns a short `xxxx…yyyy` form of a mint for UI fallback. */
function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * Fetches a single mint from Jupiter and returns the resolved TokenInfo,
 * or null when the mint is unknown. Network failures also return null so
 * the caller can serve a fallback.
 */
async function fetchFromJupiter(mint: string): Promise<TokenInfo | null> {
  try {
    const response = await fetch(`${JUPITER_SEARCH_URL}?query=${encodeURIComponent(mint)}`);
    if (!response.ok) return null;
    const tokens = (await response.json()) as JupiterSearchToken[];
    // Reason: the search endpoint can return multiple fuzzy matches — pick the exact id match.
    const match = tokens.find((t) => t.id === mint);
    if (!match) return null;
    return {
      address: match.id,
      symbol: match.symbol,
      name: match.name,
      decimals: match.decimals,
      logoURI: match.icon ?? null,
    };
  } catch {
    return null;
  }
}

/** Builds the fallback TokenInfo used when a mint cannot be resolved. */
function fallbackTokenInfo(mint: string): TokenInfo {
  return {
    address: mint,
    symbol: shortMint(mint),
    name: "Unknown Token",
    decimals: 9,
    logoURI: null,
  };
}

/**
 * Looks up token metadata by mint address.
 *
 * Flow: memory cache → storage cache → Jupiter network fetch. Results
 * (including misses) are cached with a TTL so repeated lookups for the
 * same mint never hit the network twice within the window.
 */
export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  // Reason: native SOL is a hard-coded constant, never fetch it.
  if (mint === SOL_TOKEN.address) return SOL_TOKEN;

  await hydrateFromStorage();

  const cached = memoryCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.info ?? fallbackTokenInfo(mint);
  }

  // Reason: dedupe concurrent lookups for the same mint so balance rows
  // fired in parallel don't each open their own HTTP request.
  let pending = inFlight.get(mint);
  if (!pending) {
    pending = fetchFromJupiter(mint);
    inFlight.set(mint, pending);
  }

  let info: TokenInfo | null;
  try {
    info = await pending;
  } finally {
    inFlight.delete(mint);
  }

  memoryCache.set(mint, { info, fetchedAt: Date.now() });
  // Fire-and-forget — persistence must not block the caller.
  void persistToStorage();

  return info ?? fallbackTokenInfo(mint);
}
