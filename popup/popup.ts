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

/** chrome.storage.local key the service worker uses for the contacts list. */
const KNOWN_CONTACTS_KEY = "known_contacts";

/**
 * Loads the known-contacts array from chrome.storage.local. Returns [] if
 * nothing is stored yet or if the stored value is malformed.
 */
async function loadContacts(): Promise<string[]> {
  const data = await chrome.storage.local.get(KNOWN_CONTACTS_KEY);
  const stored = data[KNOWN_CONTACTS_KEY];
  return Array.isArray(stored) ? (stored as string[]) : [];
}

/**
 * Clears the known-contacts list by writing an empty array to storage.
 * The service worker listens to chrome.storage.onChanged and refreshes
 * its in-memory cache, so the lookalike detector sees the empty list
 * on the next simulation.
 */
async function clearContacts(): Promise<void> {
  await chrome.storage.local.set({ [KNOWN_CONTACTS_KEY]: [] });
}

/**
 * Shortens a base58 address for display. 4+4 chars matches the format
 * used throughout the extension (drawer balance changes, detector
 * warnings, etc.).
 */
function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Renders the contacts list into the popup DOM. Most-recent entries
 * appear first (the stored array has newest at the end, so we reverse
 * for display). Empty list shows the empty-state message; populated
 * list shows each address as a row and enables the clear button.
 */
function renderContacts(
  contacts: string[],
  listEl: HTMLElement,
  emptyEl: HTMLElement,
  countEl: HTMLElement,
  clearBtn: HTMLButtonElement,
): void {
  countEl.textContent = String(contacts.length);

  if (contacts.length === 0) {
    listEl.innerHTML = "";
    listEl.appendChild(emptyEl);
    clearBtn.disabled = true;
    return;
  }

  listEl.innerHTML = "";
  // Reason: commitContacts appends new entries to the end, so reversing
  // gives most-recent-first ordering in the UI.
  const display = [...contacts].reverse();
  for (const address of display) {
    const row = document.createElement("div");
    row.className = "contact-row";
    row.textContent = shortenAddress(address);
    row.title = address; // full address on hover
    listEl.appendChild(row);
  }
  clearBtn.disabled = false;
}

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled") as HTMLInputElement;
  const rpcEl = document.getElementById("rpcEndpoint") as HTMLInputElement;
  const timeoutEl = document.getElementById("simulationTimeoutSec") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLElement;

  const contactsListEl = document.getElementById("contactsList") as HTMLElement;
  const contactsEmptyEl = document.getElementById("contactsEmpty") as HTMLElement;
  const contactsCountEl = document.getElementById("contactsCount") as HTMLElement;
  const clearContactsBtn = document.getElementById("clearContacts") as HTMLButtonElement;

  // Populate settings fields from stored values.
  const settings = await loadSettings();
  enabledEl.checked = settings.enabled;
  rpcEl.value = settings.rpcEndpoint;
  timeoutEl.value = String(Math.round(settings.simulationTimeoutMs / 1000));
  timeoutEl.min = String(MIN_TIMEOUT_SEC);
  timeoutEl.max = String(MAX_TIMEOUT_SEC);

  // Populate the contacts list.
  const contacts = await loadContacts();
  renderContacts(contacts, contactsListEl, contactsEmptyEl, contactsCountEl, clearContactsBtn);

  // Save settings on button click and briefly show confirmation.
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

  // Clear contacts on button click. Reloads the list from storage so the
  // UI reflects the empty state. The service worker picks up the storage
  // change via chrome.storage.onChanged and refreshes its in-memory cache.
  clearContactsBtn.addEventListener("click", async () => {
    await clearContacts();
    const fresh = await loadContacts();
    renderContacts(fresh, contactsListEl, contactsEmptyEl, contactsCountEl, clearContactsBtn);
  });
});
