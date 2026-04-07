import type { PoisoningResult } from "@/types";
import { DUST_THRESHOLD_LAMPORTS, POISONING_MATCH_CHARS } from "./constants";

/**
 * Checks if a sender address shares the first N and last N characters with
 * any known contact address.
 */
function matchesKnownContact(
  sender: string,
  contacts: string[],
  matchChars: number,
): string | null {
  const senderPrefix = sender.slice(0, matchChars);
  const senderSuffix = sender.slice(-matchChars);

  for (const contact of contacts) {
    if (contact === sender) continue;
    const contactPrefix = contact.slice(0, matchChars);
    const contactSuffix = contact.slice(-matchChars);

    if (senderPrefix === contactPrefix && senderSuffix === contactSuffix) {
      return contact;
    }
  }

  return null;
}

/**
 * Detects address poisoning when wallet context is available.
 * Compares sender against known contacts (addresses the wallet has sent to before).
 */
export function detectPoisoning(
  senderAddress: string,
  amountLamports: number,
  knownContacts: string[],
): PoisoningResult {
  if (amountLamports > DUST_THRESHOLD_LAMPORTS) {
    return { detected: false };
  }

  const matchedContact = matchesKnownContact(
    senderAddress,
    knownContacts,
    POISONING_MATCH_CHARS,
  );

  if (matchedContact) {
    return {
      detected: true,
      suspiciousAddress: senderAddress,
      realContactAddress: matchedContact,
      warning:
        "This is a dust transfer from a wallet whose address looks similar to one you've transacted with before. Scammers create look-alike addresses hoping you'll copy the wrong one next time you send funds.",
    };
  }

  return { detected: false };
}

/**
 * Detects potential address poisoning without wallet context.
 * Uses heuristic: any transfer below the dust threshold is suspicious.
 */
export function detectStandalonePoisoning(
  amountLamports: number,
): PoisoningResult {
  if (amountLamports <= DUST_THRESHOLD_LAMPORTS) {
    return {
      detected: true,
      warning:
        "This looks like a dust transfer commonly used in address poisoning attacks. Do not copy the sender's address from this transaction.",
    };
  }

  return { detected: false };
}
