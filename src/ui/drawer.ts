import type { SimulatedPreview, BalanceChange, RiskWarning } from "@/types";
import drawerStyles from "./drawer.css?inline";

/** A handle to the mounted Shadow DOM drawer. */
export interface DrawerInstance {
  /** The host element attached to document.body. */
  host: HTMLElement;
  /** The closed shadow root containing styles and container. */
  shadowRoot: ShadowRoot;
  /** The sliding panel element. */
  container: HTMLElement;
}

/**
 * Creates the Shadow DOM drawer host and attaches it to document.body.
 * Styles are encapsulated inside the shadow root so page CSS cannot interfere.
 */
export function createDrawer(): DrawerInstance {
  const host = document.createElement("div");
  host.id = "soldecode-drawer-host";
  const shadowRoot = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = drawerStyles;
  shadowRoot.appendChild(style);

  const container = document.createElement("div");
  container.className = "soldecode-drawer";
  shadowRoot.appendChild(container);

  document.body.appendChild(host);

  return { host, shadowRoot, container };
}

/**
 * Renders the preview into the drawer and slides it into view.
 * Returns a Promise that resolves with "PROCEED" or "REJECT" when the user clicks a button.
 */
export function showDrawer(
  drawer: DrawerInstance,
  preview: SimulatedPreview,
): Promise<"PROCEED" | "REJECT"> {
  return new Promise((resolve) => {
    const { container } = drawer;

    container.innerHTML = buildDrawerHTML(preview);

    // Reason: requestAnimationFrame ensures the element is in the DOM before
    // adding the "open" class so the CSS transition actually fires.
    requestAnimationFrame(() => {
      container.classList.add("open");
    });

    const proceedBtn = container.querySelector("[data-action='proceed']");
    const rejectBtn = container.querySelector("[data-action='reject']");

    const cleanup = () => {
      container.classList.remove("open");
      // Clear content after the slide-out transition completes.
      setTimeout(() => {
        container.innerHTML = "";
      }, 200);
    };

    proceedBtn?.addEventListener("click", () => {
      cleanup();
      resolve("PROCEED");
    });

    rejectBtn?.addEventListener("click", () => {
      cleanup();
      resolve("REJECT");
    });
  });
}

/**
 * Slides the drawer out of view without resolving any promise.
 * Used for programmatic dismissal.
 */
export function hideDrawer(drawer: DrawerInstance): void {
  drawer.container.classList.remove("open");
}

/**
 * Builds the full inner HTML string for the drawer from a SimulatedPreview.
 * Risk level controls badge color and button styles.
 */
function buildDrawerHTML(preview: SimulatedPreview): string {
  const badgeClass =
    preview.risk === "SAFE"
      ? "badge-safe"
      : preview.risk === "WARNING"
        ? "badge-warning"
        : "badge-danger";

  const badgeText =
    preview.risk === "SAFE" ? "SAFE" : preview.risk === "WARNING" ? "⚠ WARNING" : "⚠ DANGER";

  let html = `
    <div class="header">
      <span class="logo">⚡ SolDecode</span>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
  `;

  // Warnings (token approvals, high-value transfers, etc.)
  for (const warning of preview.warnings) {
    html += buildWarningBanner(warning);
  }

  // Error explanation (if simulation failed)
  if (preview.error) {
    html += `
      <div class="error-banner">
        <div class="error-title">⚠ ${preview.error.title}</div>
        <div class="error-text">${preview.error.reason}</div>
        <div class="fix-box">
          <div class="fix-title">💡 How to fix</div>
          ${preview.error.fixes.map((f) => `<div class="fix-item">• ${f}</div>`).join("")}
        </div>
      </div>
    `;
  }

  // One-line summary
  html += `
    <div class="card">
      <div class="summary">${preview.summary}</div>
    </div>
  `;

  // Balance changes
  if (preview.balanceChanges.length > 0) {
    html += `<div class="card"><div class="section-title">Balance Changes</div>`;
    for (const change of preview.balanceChanges) {
      html += buildBalanceRow(change);
    }
    html += `</div>`;
  }

  // Step-by-step breakdown
  if (preview.steps.length > 0) {
    // Circled number glyphs for the first 10 steps; fall back to plain numbers beyond that.
    const circled = "①②③④⑤⑥⑦⑧⑨⑩";
    html += `<div class="card"><div class="section-title">What Will Happen</div>`;
    for (const step of preview.steps) {
      const num = step.index <= circled.length ? circled[step.index - 1] : `${step.index}.`;
      html += `<div class="step">${num} ${step.description}</div>`;
    }
    html += `</div>`;
  }

  // Fee and compute unit info
  html += `<div class="fee-text">Est. fee: ~${preview.estimatedFee.toFixed(6)} SOL · CU: ${preview.computeUnits.toLocaleString()} · ${preview.origin}</div>`;

  // Action buttons — color-coded by risk level
  html += buildActionButtons(preview.risk);

  return html;
}

/**
 * Builds a single warning banner section.
 */
function buildWarningBanner(warning: RiskWarning): string {
  return `
    <div class="warning-banner">
      <div class="warning-title">🚨 ${warning.title}</div>
      <div class="warning-text">${warning.description}</div>
    </div>
  `;
}

/**
 * Builds a single balance change row with appropriate color class.
 */
function buildBalanceRow(change: BalanceChange): string {
  const cls = change.amount >= 0 ? "balance-positive" : "balance-negative";
  const sign = change.amount >= 0 ? "+" : "";
  // Cap decimal display to 6 places for tokens with many decimals (e.g. SOL has 9).
  const displayDecimals = change.decimals > 6 ? 6 : change.decimals;
  return `
    <div class="balance-row">
      <span class="balance-label">${change.symbol}</span>
      <span class="${cls}">${sign}${change.amount.toFixed(displayDecimals)}</span>
    </div>
  `;
}

/**
 * Builds the action button pair styled for the given risk level.
 * SAFE: green proceed + muted reject.
 * WARNING: muted yellow proceed + prominent red reject.
 * DANGER: gray "try anyway" + prominent red reject.
 */
function buildActionButtons(risk: SimulatedPreview["risk"]): string {
  if (risk === "SAFE") {
    return `
      <div class="actions">
        <button class="btn btn-proceed" data-action="proceed">✓ Proceed</button>
        <button class="btn btn-reject" data-action="reject">✗ Reject</button>
      </div>
    `;
  }
  if (risk === "WARNING") {
    return `
      <div class="actions">
        <button class="btn btn-proceed-warning" data-action="proceed">⚠ Proceed Anyway</button>
        <button class="btn btn-reject-prominent" data-action="reject">✗ Reject</button>
      </div>
    `;
  }
  // DANGER
  return `
    <div class="actions">
      <button class="btn btn-proceed-danger" data-action="proceed">Try Anyway</button>
      <button class="btn btn-reject-prominent" data-action="reject">✗ Reject</button>
    </div>
  `;
}
