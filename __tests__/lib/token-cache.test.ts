import { describe, it, expect, beforeEach, vi } from "vitest";

/** Mints used across the test cases. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UNKNOWN_MINT = "11111111111111111111111111111112";

/** Builds a fake Jupiter v2 search response for a single mint. */
function jupiterResponse(mint: string, symbol: string, name: string, decimals: number): unknown[] {
  return [{ id: mint, name, symbol, decimals, icon: "https://example.com/icon.png" }];
}

/**
 * Mocks chrome.storage.local to a JS map so persistence + hydration paths
 * can be exercised without a real extension runtime.
 */
function mockChromeStorage(): { store: Record<string, unknown>; chrome: unknown } {
  const store: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of list) if (k in store) result[k] = store[k];
          return result;
        }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(store, data);
        }),
      },
    },
  };
  return { store, chrome };
}

/**
 * Returns a fresh import of the token-cache module so each test starts with
 * an empty in-memory cache. Vitest module-level state otherwise leaks.
 */
async function freshTokenCache() {
  vi.resetModules();
  return await import("@/lib/token-cache");
}

beforeEach(() => {
  // Wipe any chrome stub from a previous test so we control hydration per-case.
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe("getTokenInfo", () => {
  it("falls back to the canonical SOL constant when SOL lookup fails", async () => {
    // Reason: SOL no longer short-circuits — it goes through the cache so
    // its usdPrice is captured. When the network is down, the fallback path
    // returns SOL_TOKEN so users still see "SOL" instead of a shortened mint.
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo("So11111111111111111111111111111111111111112");
    expect(info.symbol).toBe("SOL");
    expect(info.name).toBe("Solana");
    expect(info.decimals).toBe(9);
  });

  it("populates SOL with its real Jupiter fields when the network is up", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            id: "So11111111111111111111111111111111111111112",
            name: "Wrapped SOL",
            symbol: "SOL",
            decimals: 9,
            icon: "https://example.com/sol.png",
            usdPrice: 142.5,
            liquidity: 50_000_000,
            holderCount: 5_000_000,
            mcap: 80_000_000_000,
            mintAuthority: null,
            freezeAuthority: null,
          },
        ]),
        { status: 200 },
      ),
    );
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo("So11111111111111111111111111111111111111112");
    expect(info.symbol).toBe("SOL");
    expect(info.usdPrice).toBe(142.5);
    expect(info.liquidity).toBe(50_000_000);
  });

  it("fetches a mint from Jupiter and maps the response to TokenInfo", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () =>
      new Response(JSON.stringify(jupiterResponse(USDC_MINT, "USDC", "USD Coin", 6)), {
        status: 200,
      }),
    );
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo(USDC_MINT);
    expect(info.address).toBe(USDC_MINT);
    expect(info.symbol).toBe("USDC");
    expect(info.name).toBe("USD Coin");
    expect(info.decimals).toBe(6);
    expect(info.logoURI).toBe("https://example.com/icon.png");
  });

  it("returns the shortened-mint fallback when the mint is unknown", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo(UNKNOWN_MINT);
    expect(info.symbol).toContain("…");
    expect(info.symbol.startsWith(UNKNOWN_MINT.slice(0, 4))).toBe(true);
    expect(info.name).toBe("Unknown Token");
  });

  it("falls back gracefully on network failure", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo(UNKNOWN_MINT);
    expect(info.address).toBe(UNKNOWN_MINT);
    expect(info.name).toBe("Unknown Token");
  });

  it("dedupes concurrent lookups for the same mint", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(jupiterResponse(USDC_MINT, "USDC", "USD Coin", 6)), {
        status: 200,
      }),
    );
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const { getTokenInfo } = await freshTokenCache();

    const [a, b, c] = await Promise.all([
      getTokenInfo(USDC_MINT),
      getTokenInfo(USDC_MINT),
      getTokenInfo(USDC_MINT),
    ]);
    expect(a.symbol).toBe("USDC");
    expect(b.symbol).toBe("USDC");
    expect(c.symbol).toBe("USDC");
    // Reason: in-flight dedupe means three callers share one HTTP request.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not refetch within the cache window", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(jupiterResponse(USDC_MINT, "USDC", "USD Coin", 6)), {
        status: 200,
      }),
    );
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const { getTokenInfo } = await freshTokenCache();

    await getTokenInfo(USDC_MINT);
    await getTokenInfo(USDC_MINT);
    await getTokenInfo(USDC_MINT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the exact-id match when search returns multiple results", async () => {
    // The search API returns fuzzy matches. We must pick the one whose `id`
    // exactly equals the requested mint, not just `[0]`.
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { id: "OtherMint11111111111111111111111111111111111", name: "Decoy", symbol: "FAKE", decimals: 9 },
          { id: USDC_MINT, name: "USD Coin", symbol: "USDC", decimals: 6, icon: "https://example.com/usdc.png" },
        ]),
        { status: 200 },
      ),
    );
    const { getTokenInfo } = await freshTokenCache();

    const info = await getTokenInfo(USDC_MINT);
    expect(info.symbol).toBe("USDC");
  });

  it("hydrates from chrome.storage when the in-memory cache is empty", async () => {
    const storage = mockChromeStorage();
    storage.store["tokenCacheV2"] = {
      [USDC_MINT]: {
        info: {
          address: USDC_MINT,
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          logoURI: null,
        },
        fetchedAt: Date.now(),
      },
    };
    (globalThis as Record<string, unknown>).chrome = storage.chrome;
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;

    const { getTokenInfo } = await freshTokenCache();
    const info = await getTokenInfo(USDC_MINT);
    expect(info.symbol).toBe("USDC");
    // Reason: cache was hot in storage; no network request needed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists newly-resolved tokens to chrome.storage", async () => {
    const storage = mockChromeStorage();
    (globalThis as Record<string, unknown>).chrome = storage.chrome;
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () =>
      new Response(JSON.stringify(jupiterResponse(USDC_MINT, "USDC", "USD Coin", 6)), {
        status: 200,
      }),
    );

    const { getTokenInfo } = await freshTokenCache();
    await getTokenInfo(USDC_MINT);
    // Persistence is fire-and-forget so we yield once for the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect((storage.chrome as { storage: { local: { set: ReturnType<typeof vi.fn> } } }).storage.local.set).toHaveBeenCalled();
    expect(storage.store["tokenCacheV2"]).toBeDefined();
  });
});
