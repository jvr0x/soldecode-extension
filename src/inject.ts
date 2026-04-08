/**
 * SolDecode inject script — runs in the page's main world.
 * Intercepts Phantom's signTransaction calls by proxying window.solana.
 *
 * Injected by content-script.ts via <script> tag at document_start.
 */

/** Pending simulation requests awaiting user decision. */
const pendingRequests = new Map<string, {
  resolve: (action: "PROCEED" | "REJECT") => void;
}>();

/**
 * Last known connected wallet pubkey, captured whenever we wrap or call a
 * provider. Used to tell the service worker which account "the user" is, so
 * decoding works in gasless mode where the on-chain fee payer is a relayer.
 */
let lastKnownUserPubkey: string | null = null;

/**
 * Reads the connected wallet's pubkey from a legacy provider object.
 * Phantom and most legacy adapters expose `provider.publicKey` as a PublicKey
 * with a `toBase58()` method, but we accept any string-like form too.
 */
function readPubkeyFromProvider(provider: Record<string, unknown>): string | null {
  try {
    const pk = provider.publicKey as { toBase58?: () => string; toString?: () => string } | string | null | undefined;
    if (!pk) return null;
    if (typeof pk === "string") return pk;
    if (typeof pk.toBase58 === "function") return pk.toBase58();
    if (typeof pk.toString === "function") {
      const s = pk.toString();
      // Reason: PublicKey.toString() returns base58, but a plain {} returns "[object Object]".
      if (s && s !== "[object Object]") return s;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Reads the connected wallet's pubkey from a Wallet Standard wallet object,
 * which exposes `wallet.accounts[0].address` as a base58 string.
 */
function readPubkeyFromStandardWallet(wallet: Record<string, unknown>): string | null {
  try {
    const accounts = wallet.accounts as Array<{ address?: string }> | undefined;
    if (accounts && accounts.length > 0 && typeof accounts[0].address === "string") {
      return accounts[0].address;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Generates a unique request ID.
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Serializes a transaction to base64, handling both legacy and versioned transactions.
 * Tries legacy Transaction options first, falls back to VersionedTransaction (no options).
 */
function serializeTransaction(tx: unknown): string | null {
  try {
    let bytes: Uint8Array;

    if (typeof (tx as Record<string, unknown>).serialize === "function") {
      try {
        // Legacy Transaction requires these options to serialize without all signatures.
        bytes = (tx as { serialize: (opts: Record<string, boolean>) => Uint8Array }).serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
      } catch {
        // VersionedTransaction.serialize() takes no options.
        bytes = (tx as { serialize: () => Uint8Array }).serialize();
      }
    } else {
      return null;
    }

    // Convert Uint8Array to base64 without Buffer (main-world safe).
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Sends a transaction to the content script for simulation and waits for user decision.
 * Auto-rejects after 30 seconds — failing closed is the correct default for a
 * security tool. A slow or crashed service worker must not become a path around
 * the preview.
 * Returns "PROCEED" or "REJECT".
 */
function requestSimulation(base64Tx: string, userPubkey: string | null): Promise<"PROCEED" | "REJECT"> {
  return new Promise((resolve) => {
    const id = generateId();
    pendingRequests.set(id, { resolve });

    window.postMessage(
      {
        type: "SOLDECODE_SIMULATE",
        id,
        tx: base64Tx,
        origin: window.location.origin,
        userPubkey,
      },
      "*",
    );

    // Reason: fail closed on timeout. If the service worker is stalled, hung,
    // or being flooded by a hostile page, silently auto-proceeding would let a
    // tx through without any preview — the exact thing the extension exists
    // to prevent. Auto-rejecting is the safer default; the user can always
    // retry the signing flow.
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        console.log("[SolDecode] simulation timed out after 30s — auto-rejecting transaction");
        pendingRequests.delete(id);
        resolve("REJECT");
      }
    }, 30_000);
  });
}

/**
 * Listens for SOLDECODE_RESULT messages from content-script.ts.
 * Resolves the matching pending request with the user's decision.
 */
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as Record<string, unknown> | null;
  if (
    typeof data === "object" &&
    data !== null &&
    data.type === "SOLDECODE_RESULT" &&
    typeof data.id === "string"
  ) {
    const pending = pendingRequests.get(data.id);
    if (pending) {
      pendingRequests.delete(data.id);
      pending.resolve(data.action as "PROCEED" | "REJECT");
    }
  }
});

/**
 * Monkey-patches a provider's signing methods IN PLACE on the original object.
 *
 * Reason: Proxy-based wrapping creates a NEW object, but Phantom's Wallet Standard
 * adapter captures a reference to the ORIGINAL provider during init. A Proxy assigned
 * to window.phantom.solana is never seen by the adapter. By patching the methods
 * directly on the original object, any code holding a reference to it (including
 * the Wallet Standard adapter's internal `this._provider`) will call our patched
 * methods because property lookup happens at call time.
 */
function patchProvider(provider: Record<string, unknown>): void {
  if (!provider || provider.__soldecodePatched) return;

  // Patch signTransaction
  if (typeof provider.signTransaction === "function") {
    const original = (provider.signTransaction as Function).bind(provider);
    provider.signTransaction = async function (transaction: unknown) {
      console.log("[SolDecode] intercepted signTransaction");
      const base64 = serializeTransaction(transaction);
      if (base64) {
        const pubkey = readPubkeyFromProvider(provider) ?? lastKnownUserPubkey;
        if (pubkey) lastKnownUserPubkey = pubkey;
        const action = await requestSimulation(base64, pubkey);
        if (action === "REJECT") {
          throw new Error("Transaction rejected by user via SolDecode");
        }
      }
      return original(transaction);
    };
    console.log("[SolDecode] patched provider.signTransaction");
  }

  // Patch signAllTransactions
  if (typeof provider.signAllTransactions === "function") {
    const original = (provider.signAllTransactions as Function).bind(provider);
    provider.signAllTransactions = async function (transactions: unknown[]) {
      console.log(`[SolDecode] intercepted signAllTransactions (${transactions.length} txs)`);
      if (transactions.length > 0) {
        // Reason: in multi-tx batches the swap is almost always last; earlier txs
        // are setup (wrap SOL, create ATA, etc). Previewing the last tx surfaces
        // the meaningful balance changes the user actually cares about.
        const target = transactions[transactions.length - 1];
        const base64 = serializeTransaction(target);
        if (base64) {
          const pubkey = readPubkeyFromProvider(provider) ?? lastKnownUserPubkey;
          if (pubkey) lastKnownUserPubkey = pubkey;
          const action = await requestSimulation(base64, pubkey);
          if (action === "REJECT") {
            throw new Error("Transaction rejected by user via SolDecode");
          }
        }
      }
      return original(transactions);
    };
    console.log("[SolDecode] patched provider.signAllTransactions");
  }

  // Patch signAndSendTransaction
  if (typeof provider.signAndSendTransaction === "function") {
    const original = (provider.signAndSendTransaction as Function).bind(provider);
    provider.signAndSendTransaction = async function (transaction: unknown, options?: unknown) {
      console.log("[SolDecode] intercepted signAndSendTransaction");
      const base64 = serializeTransaction(transaction);
      if (base64) {
        const pubkey = readPubkeyFromProvider(provider) ?? lastKnownUserPubkey;
        if (pubkey) lastKnownUserPubkey = pubkey;
        const action = await requestSimulation(base64, pubkey);
        if (action === "REJECT") {
          throw new Error("Transaction rejected by user via SolDecode");
        }
      }
      return original(transaction, options);
    };
    console.log("[SolDecode] patched provider.signAndSendTransaction");
  }

  provider.__soldecodePatched = true;
}

/**
 * Installs proxy traps on window.solana and window.phantom.solana.
 * Uses Object.defineProperty so the trap fires whenever Phantom injects itself.
 */
/**
 * Patches providers on window.solana and window.phantom.solana in place.
 * patchProvider modifies the original object's methods, so any code holding
 * a reference to that object (including Wallet Standard adapters) will
 * call our patched methods.
 */
function install(): void {
  // Patch window.phantom.solana (the original provider that adapters capture)
  try {
    const phantom = (window as unknown as Record<string, unknown>).phantom as
      | Record<string, unknown>
      | undefined;
    if (phantom?.solana) {
      console.log("[SolDecode] patching window.phantom.solana in place");
      patchProvider(phantom.solana as Record<string, unknown>);
    }
  } catch (e) {
    console.log("[SolDecode] Could not patch window.phantom.solana:", (e as Error).message);
  }

  // Patch window.solana (may be same object or a separate reference)
  try {
    const solana = (window as unknown as Record<string, unknown>).solana as
      | Record<string, unknown>
      | undefined;
    if (solana) {
      console.log("[SolDecode] patching window.solana in place");
      patchProvider(solana);
    }
  } catch (e) {
    console.log("[SolDecode] Could not patch window.solana:", (e as Error).message);
  }

  // Trap future assignments via defineProperty (for late-loading wallets)
  try {
    const currentSolana = (window as unknown as Record<string, unknown>).solana;
    Object.defineProperty(window, "solana", {
      configurable: true,
      get() { return currentSolana; },
      set(val: Record<string, unknown>) {
        console.log("[SolDecode] window.solana was set — patching");
        patchProvider(val);
      },
    });
  } catch { /* non-configurable — already patched above */ }

  // Poll for Phantom if not yet available
  if (!(window as unknown as Record<string, unknown>).phantom) {
    let attempts = 0;
    const poller = setInterval(() => {
      attempts++;
      const phantom = (window as unknown as Record<string, unknown>).phantom as
        | Record<string, unknown>
        | undefined;
      if (phantom?.solana && !(phantom.solana as Record<string, unknown>).__soldecodePatched) {
        console.log("[SolDecode] Found phantom.solana via polling, patching");
        patchProvider(phantom.solana as Record<string, unknown>);
        clearInterval(poller);
      }
      if (attempts > 50) clearInterval(poller);
    }, 100);
  }
}

/**
 * Wraps a Wallet Standard feature method (like signTransaction).
 * The Wallet Standard passes transactions differently — as { transaction: Uint8Array } objects.
 *
 * @param wallet - The owning wallet object, used to read the connected account
 *                 so we can pass the user's pubkey to the simulator.
 */
function wrapStandardFeatureMethod(
  originalMethod: (...args: unknown[]) => Promise<unknown>,
  featureName: string,
  wallet: Record<string, unknown>,
): (...args: unknown[]) => Promise<unknown> {
  return async function (...args: unknown[]): Promise<unknown> {
    console.log(`[SolDecode] intercepted Wallet Standard ${featureName}`);

    // Wallet Standard passes an object with a `transaction` field (Uint8Array).
    // For signAllTransactions, the input shape is { transactions: [...] } — pick
    // the LAST entry because the swap is almost always the final tx in a batch.
    const input = args[0] as Record<string, unknown> | undefined;
    let base64: string | null = null;

    if (input) {
      const batched = (input as { transactions?: Uint8Array[] }).transactions;
      const txBytes: Uint8Array | undefined =
        batched && batched.length > 0
          ? batched[batched.length - 1]
          : (input.transaction as Uint8Array | undefined);

      if (txBytes instanceof Uint8Array) {
        let binary = "";
        for (let i = 0; i < txBytes.length; i++) {
          binary += String.fromCharCode(txBytes[i]);
        }
        base64 = btoa(binary);
        console.log(`[SolDecode] serialized from Wallet Standard: ${base64.length} chars${batched ? ` (last of ${batched.length})` : ""}`);
      }
    }

    if (base64) {
      // Reason: Wallet Standard requests sometimes carry the account in
      // input.account; otherwise fall back to wallet.accounts[0].
      const accountFromRequest = (input?.account as { address?: string } | undefined)?.address;
      const pubkey = accountFromRequest ?? readPubkeyFromStandardWallet(wallet) ?? lastKnownUserPubkey;
      if (pubkey) lastKnownUserPubkey = pubkey;
      const action = await requestSimulation(base64, pubkey);
      if (action === "REJECT") {
        throw new Error("Transaction rejected by user via SolDecode");
      }
    }

    return originalMethod.apply(this, args);
  };
}

/**
 * Replaces a property on a potentially frozen object.
 * Tries direct assignment first, then Object.defineProperty.
 *
 * Verifies the write actually took effect via normal property access after
 * each attempt — critical because Proxy-based feature objects may accept
 * defineProperty silently while their `get` trap keeps returning the original
 * value (observed on Jupiter Wallet). Without this verification, callers
 * think the write succeeded when it didn't.
 */
function forceSetProperty(obj: Record<string, unknown>, key: string, value: unknown): boolean {
  // Try direct assignment
  try {
    obj[key] = value;
    if (obj[key] === value) return true;
  } catch { /* frozen */ }

  // Try defineProperty (works even on frozen objects if the property is configurable)
  try {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true });
    // Reason: a Proxy with a lying `get` trap (seen on Jupiter Wallet) can
    // accept defineProperty without throwing while still serving the original.
    // Read back through normal property access to confirm the write is observable.
    if (obj[key] === value) return true;
  } catch { /* non-configurable */ }

  return false;
}

/**
 * Wraps a Wallet Standard wallet object's signing features with our interception.
 * Handles frozen and Proxy-backed feature objects via a three-strategy approach:
 * in-place mutation, entry replacement, and a wallet.features Proxy.
 */
function wrapStandardWallet(wallet: Record<string, unknown>): Record<string, unknown> {
  if ((wallet as any).__soldecodeWrapped) return wallet;

  const features = wallet.features as Record<string, Record<string, unknown>> | undefined;
  if (!features) return wallet;

  // Capture the connected pubkey now so later intercepts have a fallback even
  // if the wallet's accounts array is mutated by the time signing happens.
  const initialPubkey = readPubkeyFromStandardWallet(wallet);
  if (initialPubkey) lastKnownUserPubkey = initialPubkey;

  const walletName = (wallet as { name?: string }).name ?? "unknown";

  // Log the feature surface the wallet registered with — useful diagnostic
  // for triaging future "we wrapped it but it didn't fire" bug reports.
  try {
    const featureKeys = Object.keys(features);
    console.log(`[SolDecode] ${walletName} features: ${featureKeys.join(", ")}`);
  } catch { /* ignore */ }

  /**
   * Builds a wrapped feature object for one of the three sign-related features.
   * Tries in-place mutation + clone-and-replace as a best-effort, but always
   * returns a wrapped feature object ready to be served by the wallet.features
   * Proxy installed below. Returns null if the feature doesn't exist on this
   * wallet or its method isn't a function.
   */
  const buildWrappedFeature = (
    featureKey: string,
    methodKey: string,
  ): Record<string, unknown> | null => {
    const feature = features[featureKey];
    if (!feature || typeof feature !== "object") return null;
    const original = feature[methodKey];
    if (typeof original !== "function") return null;

    const wrapped = wrapStandardFeatureMethod(
      original as (...args: unknown[]) => Promise<unknown>,
      featureKey,
      wallet,
    );

    // Strategy 1: in-place mutation of the feature object
    if (forceSetProperty(feature, methodKey, wrapped)) {
      console.log(`[SolDecode] wrapped Wallet Standard ${featureKey} in place`);
    } else {
      // Strategy 2: clone the feature object and replace it on the features map
      const cloned = { ...feature, [methodKey]: wrapped };
      if (forceSetProperty(features, featureKey, cloned)) {
        console.log(`[SolDecode] wrapped Wallet Standard ${featureKey} (replaced feature entry)`);
      } else {
        console.log(`[SolDecode] in-place + entry-replace failed for ${featureKey}, relying on features proxy`);
      }
    }

    // Return a wrapped feature object regardless — the wallet.features Proxy
    // below serves this on every get, which is the ONLY strategy that works
    // when the feature object is itself a Proxy with a tamper-resistant getter
    // (observed on Jupiter Wallet).
    return { ...feature, [methodKey]: wrapped };
  };

  const wrappedFeatureMap = new Map<string, Record<string, unknown>>();
  const signFeatureKeys: Array<[string, string]> = [
    ["solana:signTransaction", "signTransaction"],
    ["solana:signAndSendTransaction", "signAndSendTransaction"],
    ["solana:signAllTransactions", "signAllTransactions"],
  ];
  for (const [featureKey, methodKey] of signFeatureKeys) {
    const w = buildWrappedFeature(featureKey, methodKey);
    if (w) wrappedFeatureMap.set(featureKey, w);
  }

  // Strategy 3 — wallet.features Proxy.
  // Replaces wallet.features with a Proxy whose `get` trap returns our
  // pre-built wrapped feature objects for the three sign-related keys. This
  // is the ONLY strategy that works when the underlying feature object is a
  // Proxy with a lying getter (observed on Jupiter Wallet). Uses
  // forceSetProperty so frozen-but-configurable wallet objects still get the
  // swap.
  try {
    const featuresProxy = new Proxy(features, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && wrappedFeatureMap.has(prop)) {
          return wrappedFeatureMap.get(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    if (forceSetProperty(wallet, "features", featuresProxy)) {
      console.log(`[SolDecode] installed wallet.features Proxy for ${walletName}`);
    } else {
      console.log(`[SolDecode] could not replace wallet.features for ${walletName}`);
    }
  } catch (e) {
    console.log(`[SolDecode] failed to build features Proxy for ${walletName}: ${(e as Error).message}`);
  }

  // Post-wrap verification — reads back each wrapped key through the live
  // wallet.features path and logs whether it matches the wrapper we built.
  // If any key logs MISMATCH, our interception is not visible to the dApp and
  // something else is going on — this is the diagnostic that tells us.
  try {
    const liveFeatures = wallet.features as Record<string, Record<string, unknown>> | undefined;
    for (const [featureKey, methodKey] of signFeatureKeys) {
      const expected = wrappedFeatureMap.get(featureKey);
      if (!expected) continue;
      const live = liveFeatures?.[featureKey]?.[methodKey];
      const expectedFn = expected[methodKey];
      const match = live === expectedFn;
      console.log(`[SolDecode] post-wrap check ${walletName} ${featureKey}: ${match ? "OK" : "MISMATCH"}`);
    }
  } catch (e) {
    console.log(`[SolDecode] post-wrap check failed: ${(e as Error).message}`);
  }

  try {
    (wallet as any).__soldecodeWrapped = true;
  } catch { /* frozen wallet object */ }

  return wallet;
}

/**
 * Intercepts Wallet Standard wallets by registering as an "app" in the protocol.
 *
 * Reason: Modern dApps (Jupiter, etc.) use Wallet Standard instead of window.solana.
 * The protocol works via events:
 * - Wallets dispatch 'wallet-standard:register-wallet' with a callback
 * - Apps dispatch 'wallet-standard:app-ready' with a { register } API
 * - Whichever arrives first stores its callback; when the other arrives, they handshake
 *
 * By dispatching 'wallet-standard:app-ready', we trigger already-registered wallets
 * (like Phantom) to call our register function. Since wallet objects are passed by
 * reference, mutating their features here affects the dApp's copy too.
 */
function installWalletStandardInterceptor(): void {
  // Step 1: Listen for any wallet registrations (future wallets)
  window.addEventListener("wallet-standard:register-wallet", (event: Event) => {
    const callback = (event as CustomEvent).detail;
    if (typeof callback === "function") {
      // Wallet is registering — give it our API so it calls register()
      callback({
        register(wallet: Record<string, unknown>) {
          console.log("[SolDecode] Wallet Standard: wallet registered via event:", (wallet as any).name);
          wrapStandardWallet(wallet);
        },
      });
    }
  });

  // Step 2: Dispatch app-ready to trigger already-registered wallets to re-register
  // Reason: Phantom likely registered before our script ran. Dispatching app-ready
  // causes Phantom to call back with its wallet object.
  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", {
      detail: Object.freeze({
        register(wallet: Record<string, unknown>) {
          console.log("[SolDecode] Wallet Standard: wallet registered via app-ready:", (wallet as any).name);
          wrapStandardWallet(wallet);
        },
      }),
    }),
  );

  console.log("[SolDecode] Wallet Standard interceptor installed");
}

/**
 * Intercept window.postMessage to see what Phantom sends internally.
 * This is diagnostic — we log Phantom-related messages to understand the protocol.
 */
function installPostMessageLogger(): void {
  const originalPostMessage = window.postMessage.bind(window);
  window.postMessage = function (message: unknown, ...args: unknown[]) {
    if (
      typeof message === "object" &&
      message !== null &&
      !("type" in message && (message as any).type?.startsWith?.("SOLDECODE"))
    ) {
      const msgType = (message as any).type ?? (message as any).method ?? "unknown";
      const channel = (message as any).channel ?? "";
      if (
        typeof msgType === "string" &&
        (msgType.toLowerCase().includes("sign") ||
          msgType.toLowerCase().includes("phantom") ||
          msgType.toLowerCase().includes("solana") ||
          channel.toString().toLowerCase().includes("phantom"))
      ) {
        console.log("[SolDecode] postMessage intercepted:", msgType, channel, message);
      }
    }
    return (originalPostMessage as Function).call(window, message, ...args);
  } as typeof window.postMessage;
  console.log("[SolDecode] postMessage logger installed");
}

install();
installWalletStandardInterceptor();
installPostMessageLogger();
console.log("[SolDecode] inject.ts loaded — all interceptors installed");
