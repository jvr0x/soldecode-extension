# Privacy Policy

**Last updated:** April 7, 2026

SolDecode is a Chrome extension that simulates and decodes Solana transactions before signing. This privacy policy explains what data the extension accesses and how it is handled.

## Data We Collect

None. SolDecode does not collect, store, transmit, or share any personal data or user information.

## Data That Stays on Your Device

The following data is stored locally in your browser via `chrome.storage.local` and never leaves your device:

- **Extension settings:** your enabled/disabled preference and your Helius RPC endpoint URL
- **Token metadata cache:** token names, symbols, and decimals fetched from the public Jupiter token list, cached locally to avoid repeated lookups

## Network Requests

SolDecode makes two types of network requests, both initiated by you:

1. **Transaction simulation:** when you initiate a transaction on a dApp, SolDecode sends the unsigned transaction to YOUR configured Helius RPC endpoint for simulation. This is the same RPC infrastructure the Solana network uses. The transaction is not sent to any SolDecode server.

2. **Token list:** periodically fetches the public Jupiter token list (https://token.jup.ag/strict) to resolve token mint addresses into human-readable names. This is a public, unauthenticated API.

No data is sent to SolDecode servers. We do not operate any servers.

## Analytics and Tracking

None. No analytics, telemetry, error reporting, or usage tracking of any kind.

## Third-Party Services

- **Helius RPC:** transaction simulation requests go to the Helius endpoint you configure. Helius's own privacy policy applies to those requests. You provide your own API key.
- **Jupiter Token List:** a public API with no authentication. No user data is sent.

## Data Sharing

We do not sell, share, or transfer any user data to third parties for any purpose.

## Open Source

SolDecode is fully open source under the GPL-3.0 license. You can inspect every line of code at https://github.com/jvr0x/soldecode-extension

## Changes

If this policy changes, the updated version will be published in the GitHub repository.

## Contact

For questions about this privacy policy, open an issue at https://github.com/jvr0x/soldecode-extension/issues
