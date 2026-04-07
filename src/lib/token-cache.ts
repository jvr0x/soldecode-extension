import type { TokenInfo } from "@/types";
import { SOL_TOKEN } from "./constants";

/** Jupiter strict token list API. */
const JUPITER_TOKEN_LIST_URL = "https://token.jup.ag/strict";

/** Cache TTL: 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** In-memory cache (fast lookups within service worker lifetime). */
let memoryCache: Map<string, TokenInfo> = new Map();
let lastRefresh = 0;

/** Refreshes token cache from Jupiter. Persists to chrome.storage.local. */
async function refreshCache(): Promise<void> {
  try {
    const response = await fetch(JUPITER_TOKEN_LIST_URL);
    if (!response.ok) return;
    const tokens: Array<{
      address: string; symbol: string; name: string; decimals: number; logoURI?: string;
    }> = await response.json();
    const newCache = new Map<string, TokenInfo>();
    newCache.set(SOL_TOKEN.address, SOL_TOKEN);
    for (const token of tokens) {
      newCache.set(token.address, {
        address: token.address, symbol: token.symbol, name: token.name,
        decimals: token.decimals, logoURI: token.logoURI ?? null,
      });
    }
    memoryCache = newCache;
    lastRefresh = Date.now();
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const serializable = Object.fromEntries(newCache);
      await chrome.storage.local.set({ tokenCache: serializable, tokenCacheTimestamp: lastRefresh });
    }
  } catch { /* stale cache better than none */ }
}

/** Loads cache from chrome.storage if memory is empty. */
async function loadFromStorage(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const data = await chrome.storage.local.get(["tokenCache", "tokenCacheTimestamp"]);
    if (data.tokenCache && data.tokenCacheTimestamp) {
      memoryCache = new Map(Object.entries(data.tokenCache));
      lastRefresh = data.tokenCacheTimestamp;
    }
  } catch { /* proceed with empty cache */ }
}

/** Looks up token metadata by mint. Returns fallback if not found. */
export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  if (memoryCache.size === 0) await loadFromStorage();
  if (Date.now() - lastRefresh > CACHE_TTL_MS || memoryCache.size === 0) await refreshCache();
  const cached = memoryCache.get(mint);
  if (cached) return cached;
  return {
    address: mint,
    symbol: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
    name: "Unknown Token", decimals: 9, logoURI: null,
  };
}
