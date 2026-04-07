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
 * Wraps a Phantom provider object with a Proxy that intercepts signing methods.
 * Guards against double-wrapping via __soldecodeWrapped flag.
 */
function wrapProvider(provider: Record<string, unknown>): Record<string, unknown> {
  if (!provider || provider.__soldecodeWrapped) return provider;

  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "__soldecodeWrapped") return true;

      if (prop === "signTransaction") {
        return async function (transaction: unknown) {
          console.log("[SolDecode] intercepted signTransaction");
          const base64 = serializeTransaction(transaction);
          console.log("[SolDecode] serialized:", base64 ? `${base64.length} chars` : "FAILED");
          if (base64) {
            const action = await requestSimulation(base64);
            if (action === "REJECT") {
              throw new Error("Transaction rejected by user via SolDecode");
            }
          }
          return (target.signTransaction as (tx: unknown) => Promise<unknown>)(transaction);
        };
      }

      if (prop === "signAllTransactions") {
        return async function (transactions: unknown[]) {
          // Reason: only preview the first transaction — showing N drawers would be disruptive.
          if (transactions.length > 0) {
            const base64 = serializeTransaction(transactions[0]);
            if (base64) {
              const action = await requestSimulation(base64);
              if (action === "REJECT") {
                throw new Error("Transaction rejected by user via SolDecode");
              }
            }
          }
          return (target.signAllTransactions as (txs: unknown[]) => Promise<unknown[]>)(transactions);
        };
      }

      if (prop === "signAndSendTransaction") {
        return async function (transaction: unknown, options?: unknown) {
          console.log("[SolDecode] intercepted signAndSendTransaction");
          const base64 = serializeTransaction(transaction);
          console.log("[SolDecode] serialized:", base64 ? `${base64.length} chars` : "FAILED");
          if (base64) {
            const action = await requestSimulation(base64);
            if (action === "REJECT") {
              throw new Error("Transaction rejected by user via SolDecode");
            }
          }
          return (target.signAndSendTransaction as (tx: unknown, opts?: unknown) => Promise<unknown>)(
            transaction,
            options,
          );
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Installs proxy traps on window.solana and window.phantom.solana.
 * Uses Object.defineProperty so the trap fires whenever Phantom injects itself.
 */
function install(): void {
  // Strategy 1: Wrap window.solana if it already exists
  const existingSolana = (window as unknown as Record<string, unknown>).solana as
    | Record<string, unknown>
    | undefined;
  if (existingSolana) {
    console.log("[SolDecode] window.solana already exists, wrapping immediately");
    (window as unknown as Record<string, unknown>).solana = wrapProvider(existingSolana);
  }

  // Strategy 2: Trap future window.solana assignments via defineProperty
  // Reason: Phantom may not have injected yet when our script runs
  try {
    let _solana = (window as unknown as Record<string, unknown>).solana as
      | Record<string, unknown>
      | undefined;
    if (_solana) _solana = wrapProvider(_solana);

    Object.defineProperty(window, "solana", {
      configurable: true,
      get() {
        return _solana;
      },
      set(val: Record<string, unknown>) {
        console.log("[SolDecode] window.solana was set — wrapping provider");
        _solana = wrapProvider(val);
      },
    });
  } catch (e) {
    // Property might be non-configurable — already wrapped above if it existed
    console.log("[SolDecode] Could not trap window.solana setter:", (e as Error).message);
  }

  // Strategy 3: Wrap window.phantom.solana directly if it exists
  // Reason: window.phantom is often non-configurable (Phantom locks it), so we
  // can't use defineProperty. Instead, directly replace the .solana property.
  try {
    const phantom = (window as unknown as Record<string, unknown>).phantom as
      | Record<string, unknown>
      | undefined;
    if (phantom?.solana) {
      console.log("[SolDecode] window.phantom.solana exists, wrapping directly");
      phantom.solana = wrapProvider(phantom.solana as Record<string, unknown>);
    }
  } catch (e) {
    console.log("[SolDecode] Could not wrap window.phantom.solana:", (e as Error).message);
  }

  // Strategy 4: If neither existed yet, poll briefly for Phantom to appear
  // Reason: content script injection timing is unpredictable
  if (!existingSolana) {
    let attempts = 0;
    const poller = setInterval(() => {
      attempts++;
      const sol = (window as unknown as Record<string, unknown>).solana as
        | Record<string, unknown>
        | undefined;
      if (sol && !sol.__soldecodeWrapped) {
        console.log("[SolDecode] Found window.solana via polling (attempt", attempts, ")");
        (window as unknown as Record<string, unknown>).solana = wrapProvider(sol);

        // Also wrap phantom.solana
        try {
          const phantom = (window as unknown as Record<string, unknown>).phantom as
            | Record<string, unknown>
            | undefined;
          if (phantom?.solana && !(phantom.solana as Record<string, unknown>).__soldecodeWrapped) {
            phantom.solana = wrapProvider(phantom.solana as Record<string, unknown>);
          }
        } catch { /* ignore */ }

        clearInterval(poller);
      }
      if (attempts > 50) clearInterval(poller); // Stop after ~5 seconds
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
 * Wraps a Wallet Standard wallet object's signing features with our interception.
 */
function wrapStandardWallet(wallet: Record<string, unknown>): Record<string, unknown> {
  if ((wallet as any).__soldecodeWrapped) return wallet;

  const features = wallet.features as Record<string, Record<string, unknown>> | undefined;
  if (!features) return wallet;

  // Intercept solana:signTransaction
  const signTxFeature = features["solana:signTransaction"];
  if (signTxFeature?.signTransaction && typeof signTxFeature.signTransaction === "function") {
    const original = signTxFeature.signTransaction as (...args: unknown[]) => Promise<unknown>;
    signTxFeature.signTransaction = wrapStandardFeatureMethod(original, "solana:signTransaction");
    console.log("[SolDecode] wrapped Wallet Standard solana:signTransaction");
  }

  // Intercept solana:signAndSendTransaction
  const signSendFeature = features["solana:signAndSendTransaction"];
  if (signSendFeature?.signAndSendTransaction && typeof signSendFeature.signAndSendTransaction === "function") {
    const original = signSendFeature.signAndSendTransaction as (...args: unknown[]) => Promise<unknown>;
    signSendFeature.signAndSendTransaction = wrapStandardFeatureMethod(original, "solana:signAndSendTransaction");
    console.log("[SolDecode] wrapped Wallet Standard solana:signAndSendTransaction");
  }

  (wallet as any).__soldecodeWrapped = true;
  return wallet;
}

/**
 * Intercepts Wallet Standard wallet registrations.
 * Reason: Modern dApps (Jupiter, etc.) use Wallet Standard instead of window.solana.
 * Phantom dispatches 'wallet-standard:register-wallet' events with a callback.
 * We intercept the callback to wrap the wallet before the dApp sees it.
 */
function installWalletStandardInterceptor(): void {
  // Intercept future registrations
  window.addEventListener("wallet-standard:register-wallet", (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail === "function") {
      // The detail is a callback: (api: { register: (wallet) => void }) => void
      // We can't easily intercept the callback itself, but we can intercept
      // the app-ready event that triggers wallet discovery
      console.log("[SolDecode] detected wallet-standard:register-wallet event");
    }
  }, true); // useCapture to get it before the dApp

  // Intercept the app-ready handshake by patching addEventListener
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === "wallet-standard:register-wallet" && this === window) {
      // Wrap the listener to intercept the wallet registration callback
      const wrappedListener = function (this: unknown, event: Event) {
        const originalCallback = (event as CustomEvent).detail;
        if (typeof originalCallback === "function") {
          // Replace the register function to wrap wallets before they're registered
          const wrappedCallback = (api: { register: (wallet: Record<string, unknown>) => void }) => {
            const originalRegister = api.register;
            api.register = (wallet: Record<string, unknown>) => {
              console.log("[SolDecode] intercepting Wallet Standard registration for:", (wallet as any).name);
              wrapStandardWallet(wallet);
              originalRegister(wallet);
            };
            originalCallback(api);
          };

          // Create a new event with the wrapped callback
          const wrappedEvent = new CustomEvent("wallet-standard:register-wallet", {
            detail: wrappedCallback,
            bubbles: (event as CustomEvent).bubbles,
            cancelable: (event as CustomEvent).cancelable,
          });
          if (typeof listener === "function") {
            listener.call(this, wrappedEvent);
          } else {
            listener.handleEvent(wrappedEvent);
          }
          return;
        }
        // Fallback: call original
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      };
      return originalAddEventListener.call(this, type, wrappedListener as EventListener, options);
    }
    return originalAddEventListener.call(this, type, listener, options);
  };

  console.log("[SolDecode] Wallet Standard interceptor installed");
}

install();
installWalletStandardInterceptor();
console.log("[SolDecode] inject.ts loaded — all interceptors installed");
