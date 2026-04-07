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
 * Auto-proceeds after 30 seconds to avoid blocking the user indefinitely.
 * Returns "PROCEED" or "REJECT".
 */
function requestSimulation(base64Tx: string): Promise<"PROCEED" | "REJECT"> {
  return new Promise((resolve) => {
    const id = generateId();
    pendingRequests.set(id, { resolve });

    window.postMessage(
      {
        type: "SOLDECODE_SIMULATE",
        id,
        tx: base64Tx,
        origin: window.location.origin,
      },
      "*",
    );

    // Reason: never block the user — auto-proceed if no response after 30s.
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        resolve("PROCEED");
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
        const action = await requestSimulation(base64);
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
      console.log("[SolDecode] intercepted signAllTransactions");
      if (transactions.length > 0) {
        const base64 = serializeTransaction(transactions[0]);
        if (base64) {
          const action = await requestSimulation(base64);
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
        const action = await requestSimulation(base64);
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
 */
function wrapStandardFeatureMethod(
  originalMethod: (...args: unknown[]) => Promise<unknown>,
  featureName: string,
): (...args: unknown[]) => Promise<unknown> {
  return async function (...args: unknown[]): Promise<unknown> {
    console.log(`[SolDecode] intercepted Wallet Standard ${featureName}`);

    // Wallet Standard passes an object with a `transaction` field (Uint8Array)
    // For signAndSendTransaction: { transaction: Uint8Array, ... }
    // For signTransaction: { transaction: Uint8Array, ... }
    const input = args[0] as Record<string, unknown> | undefined;
    let base64: string | null = null;

    if (input) {
      // Try to find the transaction bytes
      const txBytes = (input.transaction as Uint8Array) ??
        ((input as { transactions?: Uint8Array[] }).transactions?.[0]);

      if (txBytes instanceof Uint8Array) {
        let binary = "";
        for (let i = 0; i < txBytes.length; i++) {
          binary += String.fromCharCode(txBytes[i]);
        }
        base64 = btoa(binary);
        console.log(`[SolDecode] serialized from Wallet Standard: ${base64.length} chars`);
      }
    }

    if (base64) {
      const action = await requestSimulation(base64);
      if (action === "REJECT") {
        throw new Error("Transaction rejected by user via SolDecode");
      }
    }

    return originalMethod.apply(this, args);
  };
}

/**
 * Replaces a property on a potentially frozen object.
 * Tries direct assignment first, then Object.defineProperty, then returns false.
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
    return true;
  } catch { /* non-configurable */ }

  return false;
}

/**
 * Wraps a Wallet Standard wallet object's signing features with our interception.
 * Handles frozen feature objects by replacing them on the wallet.features map.
 */
function wrapStandardWallet(wallet: Record<string, unknown>): Record<string, unknown> {
  if ((wallet as any).__soldecodeWrapped) return wallet;

  const features = wallet.features as Record<string, Record<string, unknown>> | undefined;
  if (!features) return wallet;

  // Intercept solana:signTransaction
  const signTxFeature = features["solana:signTransaction"];
  if (signTxFeature?.signTransaction && typeof signTxFeature.signTransaction === "function") {
    const original = signTxFeature.signTransaction as (...args: unknown[]) => Promise<unknown>;
    const wrapped = wrapStandardFeatureMethod(original, "solana:signTransaction");

    if (!forceSetProperty(signTxFeature, "signTransaction", wrapped)) {
      // Feature object is frozen — replace the entire feature entry
      const newFeature = { ...signTxFeature, signTransaction: wrapped };
      forceSetProperty(features, "solana:signTransaction", newFeature);
      console.log("[SolDecode] wrapped Wallet Standard solana:signTransaction (replaced frozen feature)");
    } else {
      console.log("[SolDecode] wrapped Wallet Standard solana:signTransaction");
    }
  }

  // Intercept solana:signAndSendTransaction
  const signSendFeature = features["solana:signAndSendTransaction"];
  if (signSendFeature?.signAndSendTransaction && typeof signSendFeature.signAndSendTransaction === "function") {
    const original = signSendFeature.signAndSendTransaction as (...args: unknown[]) => Promise<unknown>;
    const wrapped = wrapStandardFeatureMethod(original, "solana:signAndSendTransaction");

    if (!forceSetProperty(signSendFeature, "signAndSendTransaction", wrapped)) {
      // Feature object is frozen — replace the entire feature entry
      const newFeature = { ...signSendFeature, signAndSendTransaction: wrapped };
      forceSetProperty(features, "solana:signAndSendTransaction", newFeature);
      console.log("[SolDecode] wrapped Wallet Standard solana:signAndSendTransaction (replaced frozen feature)");
    } else {
      console.log("[SolDecode] wrapped Wallet Standard solana:signAndSendTransaction");
    }
  }

  // Also wrap the wallet.features getter with a Proxy so even if the dApp
  // looks up features later, it gets our wrapped versions
  if (!Object.isFrozen(wallet)) {
    try {
      const featuresProxy = new Proxy(features, {
        get(target, prop, receiver) {
          return Reflect.get(target, prop, receiver);
        },
      });
      wallet.features = featuresProxy;
    } catch { /* ignore if we can't replace */ }
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
