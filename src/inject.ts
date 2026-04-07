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
          const base64 = serializeTransaction(transaction);
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
          const base64 = serializeTransaction(transaction);
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
  // Trap window.solana
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
      _solana = wrapProvider(val);
    },
  });

  // Trap window.phantom.solana
  let _phantom = (window as unknown as Record<string, unknown>).phantom as
    | Record<string, unknown>
    | undefined;
  if (_phantom?.solana) {
    _phantom.solana = wrapProvider(_phantom.solana as Record<string, unknown>);
  }

  Object.defineProperty(window, "phantom", {
    configurable: true,
    get() {
      return _phantom;
    },
    set(val: Record<string, unknown>) {
      if (val?.solana) {
        val.solana = wrapProvider(val.solana as Record<string, unknown>);
      }
      _phantom = val;
    },
  });
}

install();
