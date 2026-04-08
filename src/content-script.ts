/**
 * SolDecode content script — runs in the isolated world.
 * Bridges messages between inject.ts (main world) and service-worker.ts (background).
 * Mounts the Shadow DOM preview drawer when a simulation result is ready.
 */

import { createDrawer, showDrawer, showConfirmationToast } from "./ui/drawer";

/** Injects the main-world script via a <script> tag at document start. */
function injectMainWorldScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
}

/** Drawer instance — created lazily on first use. */
let drawer: ReturnType<typeof createDrawer> | null = null;

/** Returns the existing drawer or creates a new one. */
function getDrawer(): ReturnType<typeof createDrawer> {
  if (!drawer) {
    drawer = createDrawer();
  }
  return drawer;
}

/**
 * Listens for SOLDECODE_SIMULATE messages posted by inject.ts.
 * Checks extension settings, relays to service worker, shows the drawer,
 * and posts the user's decision back to inject.ts.
 * On any error, auto-proceeds so the user is never blocked.
 */
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data as Record<string, unknown> | null;

  if (
    typeof data !== "object" ||
    data === null ||
    data.type !== "SOLDECODE_SIMULATE"
  ) {
    return;
  }

  const { id, tx, origin, userPubkey } = data as {
    id: string;
    tx: string;
    origin: string;
    userPubkey?: string | null;
  };
  console.log("[SolDecode] content-script received SOLDECODE_SIMULATE, id:", id, "user:", userPubkey ?? "(unknown)");

  try {
    // Check whether the extension is enabled and has an RPC endpoint configured.
    const settingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as
      | { enabled: boolean; configured: boolean }
      | undefined;

    console.log("[SolDecode] settings response:", settingsResponse);
    if (!settingsResponse?.enabled || !settingsResponse?.configured) {
      // Not configured or disabled — let the transaction proceed without preview.
      window.postMessage({ type: "SOLDECODE_RESULT", id, action: "PROCEED" }, "*");
      return;
    }

    // Ask the service worker to simulate and decode the transaction.
    const response = await chrome.runtime.sendMessage({
      type: "SIMULATE",
      id,
      tx,
      origin,
      userPubkey,
    }) as { type: string; preview?: unknown; error?: string } | undefined;

    if (response?.type === "SIMULATE_RESULT" && response.preview) {
      // Show the drawer and wait for the user's decision.
      const d = getDrawer();
      const action = await showDrawer(d, response.preview as import("@/types").SimulatedPreview);
      window.postMessage({ type: "SOLDECODE_RESULT", id, action }, "*");
    } else if (response?.type === "SIMULATE_ERROR") {
      // Reason: fail closed on simulation errors. An attacker can construct
      // a tx that deliberately breaks simulation (e.g. referencing accounts
      // that cause the simulator to bail); auto-proceeding here would be a
      // bypass of the entire preview pipeline. Legitimate RPC hiccups are
      // retry-able — the user can resubmit.
      console.warn("[SolDecode] Simulation error, auto-rejecting:", response.error);
      window.postMessage({ type: "SOLDECODE_RESULT", id, action: "REJECT" }, "*");
    } else {
      // Reason: unexpected response shape means either a code bug or a
      // version mismatch between content-script and service-worker. Either
      // way, the preview is not available, so fail closed.
      console.warn("[SolDecode] Unexpected response from service worker, auto-rejecting:", response);
      window.postMessage({ type: "SOLDECODE_RESULT", id, action: "REJECT" }, "*");
    }
  } catch (error) {
    // Reason: runtime failures typically mean the extension context was
    // invalidated (e.g. extension was updated mid-session) or
    // chrome.runtime.sendMessage threw. The extension is effectively
    // broken; the user should reload the page rather than sign without a
    // preview. Fail closed and log so the user can see why in devtools.
    // window.postMessage itself does not rely on chrome.runtime and will
    // still deliver the REJECT to inject.ts.
    console.warn("[SolDecode] Runtime error in content script, auto-rejecting:", error);
    window.postMessage({ type: "SOLDECODE_RESULT", id, action: "REJECT" }, "*");
  }
});

/**
 * Listens for SOLDECODE_TRACK messages from inject.ts (fire-and-forget).
 * Relays to the service worker which handles the on-chain polling.
 */
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as Record<string, unknown> | null;
  if (
    typeof data !== "object" ||
    data === null ||
    data.type !== "SOLDECODE_TRACK"
  ) {
    return;
  }
  const { signature, userPubkey, origin } = data as {
    signature: string;
    userPubkey?: string | null;
    origin: string;
  };
  console.log("[SolDecode] content-script forwarding TRACK_TX, sig:", signature.slice(0, 8) + "…");
  // Fire-and-forget — service worker handles polling and pushes TX_STATUS back.
  chrome.runtime.sendMessage({
    type: "TRACK_TX",
    signature,
    userPubkey,
    origin,
  }).catch((err) => {
    console.warn("[SolDecode] TRACK_TX send failed:", err);
  });
});

/**
 * Listens for TX_STATUS messages pushed from the service worker after it
 * finishes polling the chain. Displays a non-blocking confirmation toast
 * in the drawer shadow DOM.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as Record<string, unknown>;
  if (msg.type !== "TX_STATUS") return;
  const status = msg.status as "CONFIRMED" | "DIVERGED" | "FAILED" | "DROPPED";
  const detail = typeof msg.detail === "string" ? msg.detail : "";
  const d = getDrawer();
  showConfirmationToast(d, status, detail);
});

// Inject the main-world script immediately at document_start.
injectMainWorldScript();
console.log("[SolDecode] content-script loaded");
