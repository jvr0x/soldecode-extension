# Changelog

All notable changes to SolDecode are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-token divergence detection** in the post-submission tracker. The `computeDivergence` function in `src/service-worker.ts` now flags two additional classes of result drift beyond the per-simulated-mint comparison: "surprise tokens" (any mint that appears in the actual finalized transaction but was not in the simulated preview) and "surprise SOL" (a non-trivial SOL delta when the simulation predicted none). The first catches token-impersonation scams where a user expected BONK and received FAKE_BONK at a different mint; the second catches unexpected SOL movement above the fee-dust threshold.
- **Configurable simulation timeout** via the popup. Users can now set the auto-reject timeout between 10 and 120 seconds (default 30) to accommodate slow RPC providers. The value is threaded from `chrome.storage.local` through the service worker's `GET_SETTINGS` response to the content script, and from there to `inject.ts` via a new `SOLDECODE_GET_CONFIG` / `SOLDECODE_CONFIG` message handshake at page load. The timeout is defensively re-clamped in `inject.ts` in case the message bus carries an out-of-bounds value. Fail-closed semantics are unchanged - only the threshold is tunable.
- **Trusted Recipients UI** in the popup. The previously-invisible `known_contacts` list used by the lookalike-destination detector is now displayed as a scrollable list of 4+4-character shortened addresses below the settings form. Users can inspect which addresses the lookalike detector treats as trusted and clear the full history with one click. Cache coherence between the popup and the service worker's in-memory `cachedContacts` is handled via a `chrome.storage.onChanged` listener in the service worker, which refreshes the cache whenever `known_contacts` is written from any context.
- **Landing page at `https://jvr0x.github.io/soldecode-extension/`**, deployed via GitHub Actions to the `gh-pages` branch. The page has a live HTML replica of the preview drawer in the hero (not a screenshot - real HTML so it stays sharp at every resolution and search engines can index the drawer text), a detector grid describing six risk categories, three product screenshots for Jupiter / Kamino / MarginFi, install instructions covering both the future Chrome Web Store listing and the from-source flow, and a footer with version metadata and attribution to [@jvr0x](https://x.com/jvr0x). Uses plain HTML with Tailwind CSS via the Play CDN - no build toolchain, no node_modules for the website.
- **Accessibility polish** on the landing page: `prefers-reduced-motion` media query overrides `scroll-behavior: smooth` for users with vestibular disorders, a global `focus-visible` style applies a teal ring to every `<a>` and `<button>` for keyboard navigation, and the top-nav breakpoint was widened from `md:` to `sm:` so landscape phones see the full navigation instead of just the logo.

### Changed

- **Brave Wallet removed from the Supported Wallets list.** It was previously listed as "not yet verified" pending investigation. Brave Wallet is built into the browser rather than injected as a Chrome extension, and its signing path bypasses the page-world Wallet Standard interception SolDecode relies on. Supporting it would require a fundamentally different hooking approach and the user base is small enough that the explanation is not worth carrying in the README.

## [0.5.0] - 2026-04-08

### Added

- **Sub-dust incoming SOL detector.** Wires the previously orphan `src/lib/poisoning-detector.ts` module into the risk analyzer. The new `detectDustSolReceipt` function fires when a signed transaction would deposit less than 0.001 SOL (1,000,000 lamports) into the user's account. That pattern shows up in drainer bait, airdrop-tagged wallet profiling, and as a setup step for downstream address-poisoning attacks. Fires at `warning` severity rather than `critical` because some legitimate swaps return tiny SOL amounts as side effects.
- **Impersonator token detector.** New `CANONICAL_TOKENS` table in `src/lib/constants.ts` mapping the top 11 spoofable ticker symbols (USDC, USDT, SOL, WSOL, JUP, BONK, WIF, JTO, RAY, PYTH, W) to their canonical mint addresses. The new `detectImpersonatorToken` function walks balance changes and flags any token whose normalized symbol matches the table but whose mint does not. Direction-agnostic - catches both incoming fake-token airdrops and outgoing swap legs that output a copycat mint. Fires at `critical` severity because the false-positive rate on the canonical table is effectively zero.
- **Unicode homoglyph hardening on the impersonator detector.** The symbol normalization pipeline (`normalizeSymbol` in `src/lib/risk-analyzer.ts`) applies NFKD decomposition, strips zero-width and invisible characters (`\u200B–\u200F`, `\u2060`, `\uFEFF`, `\u00AD`), maps ~40 Cyrillic and Greek confusable letters to their Latin equivalents via a hand-curated `SYMBOL_CONFUSABLES` table, and then uppercases. Catches four documented bypass classes: Cyrillic lookalikes (`USDС` with U+0421), Greek lookalikes (`PΥTΗ` with U+03A5 and U+0397), fullwidth forms (`ＵＳＤＣ` using U+FF21..U+FF5A), and zero-width joiner insertion (`US\u200DDC`).
- **Contacts-aware lookalike-destination detector.** The existing `matchesKnownContact` helper in `poisoning-detector.ts` is now exported, and a new `detectLookalikeDestination` function in `risk-analyzer.ts` walks outgoing `System Program Transfer` and `SPL Token Transfer` / `TransferChecked` destinations against a stored list of addresses the user has previously sent to. Flags any destination that shares first/last 4 characters with a known contact but isn't that contact. This catches Phase 2 of the address poisoning attack (the user copy-pasting a poisoned address from their wallet history). The contacts store is populated by the post-submission tracker - only destinations from *confirmed* signed transactions are committed, so a rejected or dropped transaction cannot poison the store. Capped at 500 most-recent entries.
- **Post-submission transaction tracker with divergence detection.** After the user clicks Proceed, the extension now captures the resulting transaction signature from the wallet return value, polls `getSignatureStatus` every 2 seconds for up to 60 seconds, fetches the finalized transaction via `getTransaction`, and compares the actual balance changes against the simulated preview at a 5% threshold. Result classification:
  - **CONFIRMED** - finalized, balance diffs match preview within 5%
  - **DIVERGED** - finalized but ≥5% drift on some simulated mint (catches MEV sandwich losses, slippage blowouts, token-address swaps)
  - **FAILED** - finalized with on-chain error
  - **DROPPED** - not confirmed within 60 seconds
  Delivered as a non-blocking toast in the drawer shadow DOM, independent of the sliding preview drawer, auto-dismissing after 10 seconds. Works for all four sign entry points (legacy `signTransaction` / `signAndSendTransaction`, Wallet Standard `solana:signTransaction` / `solana:signAndSendTransaction`) via a defensive signature-extraction helper that handles all observed wallet return shapes. Includes a ~20-line inline base58 encoder so `inject.ts` does not need to pull `bs58` as a new dependency into the page main world.
- **Solflare and Backpack** added to the Supported Wallets list. Both verified working out of the box thanks to v0.4.0's Proxy-based `wallet.features` wrap - no new code was needed, just verification. The Proxy fix was brand-agnostic by design.

### Changed

- **Auto-reject on simulation timeout** instead of auto-proceeding. The 30-second failsafe in `requestSimulation` (src/inject.ts) previously resolved to `PROCEED` when the service worker did not respond, which meant a stalled or crashed service worker silently became a bypass of the entire preview pipeline. Flipped to `REJECT` with a diagnostic console log. A hostile page that could stall the service worker for 30+ seconds can no longer sail transactions through.
- **Fail-closed on unexpected content-script errors.** Three of the four fallback branches in `src/content-script.ts` (the `SIMULATE_ERROR` response from the service worker, the unexpected-shape response, and the generic `catch` block) previously auto-proceeded. All three now reject with an explanatory console log. The fourth branch (extension disabled or no RPC endpoint configured) still proceeds because that is the user's explicit opt-out. Closes several silent-bypass holes an attacker could exploit via crafted transactions that break simulation.

### Security

- Closed the "stalled service worker silently bypasses the preview" hole (see auto-reject-on-timeout above).
- Closed the "hostile page forces a `SIMULATE_ERROR` to bypass the preview" hole (see fail-closed on content-script errors above).
- Added the new detectors above to catch patterns that were previously invisible to the risk analyzer.

## [0.4.0] - 2026-04-08

### Added

- **Jupiter Wallet support** via the Wallet Standard path. Previously only Phantom was intercepted. Investigation revealed Jupiter Wallet's feature objects are wrapped in tamper-resistant Proxies that accept `Object.defineProperty` writes but keep returning the original function from their `get` trap, which caused the previous `forceSetProperty` to log "wrapped" when nothing had actually taken.
- **Permanent post-wrap verification logs.** Every wallet registration now emits `[SolDecode] <wallet> features: <keys>` enumerating the wallet's Wallet Standard feature surface, plus `[SolDecode] post-wrap check <wallet> <feature>: OK | MISMATCH` confirming whether our wrap is actually visible through the live `wallet.features` lookup. This replaces the temporary Phase 1 discovery instrumentation that was used during the Jupiter investigation and gives future wallet triage a permanent diagnostic.

### Fixed

- **`forceSetProperty` now verifies writes after `Object.defineProperty`**, not just after direct assignment. A Proxy with a lying `get` trap can accept `defineProperty` without throwing while still serving the original value; without the post-write identity check, the caller mistakenly believed the write succeeded. (src/inject.ts)
- **The `wallet.features` Proxy is now a real routing proxy** that serves pre-built wrapped feature objects from an in-function `Map` for the three sign-related keys (`solana:signTransaction`, `solana:signAndSendTransaction`, `solana:signAllTransactions`), falling through to `Reflect.get` for everything else. The previous implementation was a no-op proxy whose `get` trap did `Reflect.get(target, prop, receiver)` - literally the default behavior - and served unchanged feature objects. (src/inject.ts)
- **The `wallet.features` assignment now goes through `forceSetProperty`** instead of a bare write gated on `!Object.isFrozen(wallet)`. Frozen-but-configurable wallet objects were previously silently dropping the swap. (src/inject.ts)

## [0.3.0] and earlier

Release history prior to v0.4.0 is not captured in this changelog; see the git log and release tags on GitHub for earlier versions.

The main themes of the pre-v0.4.0 releases were:

- **v0.1.0** - Initial implementation of the preview drawer, transaction simulation via `simulateTransaction` RPC, legacy Phantom provider patching, Shadow DOM drawer.
- **v0.2.0** - Screenshots refresh, basic risk warnings.
- **v0.3.0** - Phase A + B risk detectors (drain heuristic, multi-asset outflow, unlimited approvals, account ownership hijacks, mint authority changes, stake authority transfers, token-metadata detectors driven by Jupiter token API data).

---

## Reference

- [Jupiter Wallet design spec](docs/superpowers/specs/2026-04-08-jupiter-wallet-support-design.md) - the v0.4.0 investigation
- [Landing page design spec](docs/superpowers/specs/2026-04-08-landing-page-design.md) - the website architecture
- [Implementation plans](docs/superpowers/plans/) - the task-by-task work that produced the commits above

[Unreleased]: https://github.com/jvr0x/soldecode-extension/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jvr0x/soldecode-extension/releases/tag/v0.5.0
[0.4.0]: https://github.com/jvr0x/soldecode-extension/releases/tag/v0.4.0
