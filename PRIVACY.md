# Privacy Policy

**Last updated:** April 15, 2026

SolDecode is a Chrome extension that simulates and decodes Solana transactions before signing. This privacy policy explains what data the extension accesses and how it is handled.

## Data We Collect

None. SolDecode does not collect, store, transmit, or share any personal data or user information.

## Data That Stays on Your Device

The following data is stored locally in your browser via `chrome.storage.local` and never leaves your device:

- **Extension settings:** your enabled/disabled preference, your Helius RPC endpoint URL, and your simulation timeout in seconds (10-120)
- **Token metadata cache:** token names, symbols, and decimals fetched from the public Jupiter token list, cached locally to avoid repeated lookups
- **Trusted Recipients (known contacts):** the destination addresses from your most recent confirmed transactions, capped at 500 entries with oldest-first eviction. This list powers the lookalike-destination detector, which flags copy-pasted addresses that share the first and last 4 characters with one of your real contacts. Only destinations from transactions that were actually finalized on-chain are added, so rejected or dropped transactions cannot poison the list. You can inspect the full list and clear it from the popup at any time.
- **Post-submission signature tracking (transient):** after you sign a transaction, SolDecode captures the resulting signature and polls `getSignatureStatus` for up to 60 seconds to fetch the finalized transaction for divergence comparison. The signature and its status are held in the service worker's in-memory state only for the duration of the poll and are never persisted.

## Network Requests

SolDecode makes three types of network requests, all initiated by you:

1. **Transaction simulation:** when you initiate a transaction on a dApp, SolDecode sends the unsigned transaction to YOUR configured Helius RPC endpoint for simulation (`simulateTransaction`). This is the same RPC infrastructure the Solana network uses. The transaction is not sent to any SolDecode server.

2. **Post-submission verification:** after you sign a transaction, SolDecode polls the same configured Helius endpoint with `getSignatureStatus` and `getTransaction` for up to 60 seconds to check whether the finalized transaction matches the preview you were shown before signing. If the result diverges (surprise tokens, surprise SOL movement, or greater than 5% balance drift on a simulated mint), a non-blocking toast is displayed in the drawer. These calls go to the same endpoint you configured for simulation, never to a SolDecode server.

3. **Token list:** periodically fetches the public Jupiter token list (https://token.jup.ag/strict) to resolve token mint addresses into human-readable names. This is a public, unauthenticated API.

No data is sent to SolDecode servers. We do not operate any servers.

## Analytics and Tracking

None. No analytics, telemetry, error reporting, or usage tracking of any kind.

## Third-Party Services

- **Helius RPC:** Solana RPC requests (transaction simulation and post-submission verification) go to the Helius endpoint you configure. Helius's own privacy policy applies to those requests. You provide your own API key.
- **Jupiter Token List:** a public API with no authentication. No user data is sent.

## Data Sharing

We do not sell, share, or transfer any user data to third parties for any purpose.

## Open Source

SolDecode is fully open source under the GPL-3.0 license. You can inspect every line of code at https://github.com/jvr0x/soldecode-extension

## Changes

If this policy changes, the updated version will be published in the GitHub repository.

## Contact

For questions about this privacy policy, open an issue at https://github.com/jvr0x/soldecode-extension/issues
