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

install();
console.log("[SolDecode] inject.ts loaded — proxy traps installed");
