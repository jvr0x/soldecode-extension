/**
 * SolDecode popup — extension settings UI.
 * Loads settings from chrome.storage on mount and saves on button click.
 */

/** Extension settings shape (mirrors ExtensionSettings from src/types). */
interface Settings {
  /** Whether the extension intercepts signing requests. */
  enabled: boolean;
  /** Helius RPC endpoint URL including API key. */
  rpcEndpoint: string;
  /**
   * Simulation timeout in ms. The popup exposes this in seconds but stores
   * the ms value to match the rest of the extension's time units.
   */
  simulationTimeoutMs: number;
}

/** Default simulation timeout (30 seconds) if the user has not set one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Min/max bounds for the timeout input (seconds). */
const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 120;

/** Loads settings from chrome.storage.local, returning defaults if absent. */
async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get("settings");
  const stored = data.settings as Partial<Settings> | undefined;
  return {
    enabled: stored?.enabled ?? true,
    rpcEndpoint: stored?.rpcEndpoint ?? "",
    simulationTimeoutMs: stored?.simulationTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Persists settings to chrome.storage.local. */
async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

/** Clamps a seconds value to the allowed bounds, returning ms. */
function clampTimeoutSecToMs(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_TIMEOUT_MS;
  const clamped = Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(sec)));
  return clamped * 1000;
}

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled") as HTMLInputElement;
  const rpcEl = document.getElementById("rpcEndpoint") as HTMLInputElement;
  const timeoutEl = document.getElementById("simulationTimeoutSec") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLElement;

  // Populate fields from stored settings.
  const settings = await loadSettings();
  enabledEl.checked = settings.enabled;
  rpcEl.value = settings.rpcEndpoint;
  timeoutEl.value = String(Math.round(settings.simulationTimeoutMs / 1000));
  timeoutEl.min = String(MIN_TIMEOUT_SEC);
  timeoutEl.max = String(MAX_TIMEOUT_SEC);

  // Save on button click and briefly show confirmation.
  saveBtn.addEventListener("click", async () => {
    await saveSettings({
      enabled: enabledEl.checked,
      rpcEndpoint: rpcEl.value.trim(),
      simulationTimeoutMs: clampTimeoutSecToMs(Number(timeoutEl.value)),
    });
    statusEl.style.display = "block";
    setTimeout(() => {
      statusEl.style.display = "none";
    }, 2000);
  });
});
