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
}

/** Loads settings from chrome.storage.local, returning defaults if absent. */
async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get("settings");
  return (data.settings as Settings | undefined) ?? { enabled: true, rpcEndpoint: "" };
}

/** Persists settings to chrome.storage.local. */
async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled") as HTMLInputElement;
  const rpcEl = document.getElementById("rpcEndpoint") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLElement;

  // Populate fields from stored settings.
  const settings = await loadSettings();
  enabledEl.checked = settings.enabled;
  rpcEl.value = settings.rpcEndpoint;

  // Save on button click and briefly show confirmation.
  saveBtn.addEventListener("click", async () => {
    await saveSettings({
      enabled: enabledEl.checked,
      rpcEndpoint: rpcEl.value.trim(),
    });
    statusEl.style.display = "block";
    setTimeout(() => {
      statusEl.style.display = "none";
    }, 2000);
  });
});
