/**
 * SolDecode content script — runs in the isolated world.
 * Bridges messages between inject.ts (main world) and service-worker.ts (background).
 * Mounts the Shadow DOM preview drawer when a simulation result is ready.
 */

import { createDrawer, showDrawer } from "./ui/drawer";

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

  const { id, tx, origin } = data as { id: string; tx: string; origin: string };

  try {
    // Check whether the extension is enabled and has an RPC endpoint configured.
    const settingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as
      | { enabled: boolean; configured: boolean }
      | undefined;

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
    }) as { type: string; preview?: unknown; error?: string } | undefined;

    if (response?.type === "SIMULATE_RESULT" && response.preview) {
      // Show the drawer and wait for the user's decision.
      const d = getDrawer();
      const action = await showDrawer(d, response.preview as import("@/types").SimulatedPreview);
      window.postMessage({ type: "SOLDECODE_RESULT", id, action }, "*");
    } else if (response?.type === "SIMULATE_ERROR") {
      // Simulation errored — warn but don't block the user.
      console.warn("[SolDecode] Simulation error:", response.error);
      window.postMessage({ type: "SOLDECODE_RESULT", id, action: "PROCEED" }, "*");
    } else {
      // Unexpected response shape — auto-proceed.
      window.postMessage({ type: "SOLDECODE_RESULT", id, action: "PROCEED" }, "*");
    }
  } catch (error) {
    // Reason: any runtime failure (extension context invalidated, RPC down, etc.)
    // must never block the page. Always fall through to PROCEED.
    console.warn("[SolDecode] Error in content script:", error);
    window.postMessage({ type: "SOLDECODE_RESULT", id, action: "PROCEED" }, "*");
  }
});

// Inject the main-world script immediately at document_start.
injectMainWorldScript();
