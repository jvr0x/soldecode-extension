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
      <span class="logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEI0lEQVR4nFWU3W8UVRjGf+ecmd2dtttuKxSktBuhBS0hthICCUJAQFEiMTFeeKE33hpULvAfUC+80Au4MjHxDzBqBANKJH5EjR80SslK/Ai0pRLodmm3u7PbmTnnmDO7hXJmJnPmzOSZ9zzP8z4CYHhwx2aJ/y6WgxbbDQi3LoTAYtuPltXT9rBAVQjxdYP45MzMpX/FpoFdI0pwQUmvaKy++yVKgrWQmNZdSawU6VzcA8RhSqnQJp4yNjkkleSUUl5RmyRO3wuRXqLaQIQRJuehu3JYa5HVBjLSIOU9PGExNo6lUkUrOC2GN+5alkL46WYcUKLTKmp7t1J/fAvxxj5sRiEXQrJXZ8mfnyR7rYzNZ8GYlJL24epOxMjGXdZxtQKmOzKUjx8m3LMFfA9RDSGKMPkOyGWQc4v0fvgNPV9NojuzYE1avWPbCPBSFtKFFsNzJ44Q7hlB/lchOD9BcOk6cjkmfrCX+uHtxDtGqLz2NDSXyX93FduVQxhXoePXtAAd4XKpycKxMcLdw6jZCt3vn6Hnl2lkNov1JPJqmfyPfzP36mGWj+5k8eV9BJenUM0E26bUVZlO3R9M1qO+d2tqi9yXExR+mkLmcuiuDLKeoPrsGJXXj9L30bfIqdvowX7C8SKi0Wyp7/YnQKbcaUNS6CBZX0DUGwQTU9hCJ9WntqGqIbUDo8y/sp/g57/wFxtkSjOpUFFxDdaYtmlbinupcd2pHKMyBVexQWhNbd/DLD25HZPPsfadTwj+mMJm/ZTT1F6+SkGQtqW4s5Zog6laE7UQYjsDoofWoMJl+t/+FDm/RN/pcwR/X8f0BBgFcbEfoS3y9kILcJXTpXuwnsCrhmQnpxG+T/3IGI11nailkP63PiZXmsV2ZVFzi2nV0SMDiPIimcnrkPXBrAZ0gluLzfnkP/8NcXMePVqkfOIZwm0bMK5LpEXnfO68sJvqS/sRQQ7/hysEf85iO5wX7wGKkcGdVkgwEkS9SX28SOXkc9gHuqFSxb92C9GI0esLJINrEc7sN27DnSUKX0yQv3gZ09ORVmmtQQwP7Wi5esWPtSZhsY/FF/cQP7oJU+hKxaIZo26UyZ37lWjrAPET44iwSe+pM3R9X8IEmVQYsXnosVbrpcOkjS+aEVonRAO9RBt6sVkPVanhz8yRma8RD66l/ObzJKND0Fhm3fEPyNxawLrqNw+NR0JID6zLjVYLOqO609kjSe7GlxPAZnxErUHcHVB+4xjWWNa89xmZyFgtSMSmwbGLnucf0CaKkfh3Q3RVlLU7tc2T851EuiAxOv1cImKVzfhJklwUw0Ojo1b4F6RSG+4L2JX4XKXgfcN1WDtghQvYJLmprT4k/5kulRL0QW30WReDtjVSxVrXCuDqu+uG9L3b8ZLR5qzBHJyeLpX+B5ELCZQxZNPsAAAAAElFTkSuQmCC" style="width:18px;height:18px;vertical-align:middle;margin-right:6px;border-radius:4px;"> SolDecode</span>
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
