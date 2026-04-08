import type { ParsedTransaction } from "@/types";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./constants";

/** System Program address — used as a base58 literal rather than a constant. */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** SPL Token instruction discriminator for legacy Transfer. */
const TOKEN_IX_TRANSFER = 3;

/** SPL Token instruction discriminator for TransferChecked. */
const TOKEN_IX_TRANSFER_CHECKED = 12;

/**
 * Walks the top-level instructions of a parsed transaction and returns
 * every destination address the user is about to SEND to. Filters:
 *
 *  - System Program Transfer (discriminator u32 LE = 2, destination at
 *    accounts[1]).
 *  - SPL Token Transfer (first byte = 3, destination at accounts[1]).
 *  - SPL Token TransferChecked (first byte = 12, destination at
 *    accounts[2]).
 *
 * Self-transfers (destination === userPubkey) are filtered out because
 * they should not end up in the contacts store.
 *
 * The returned array is deduplicated to avoid multiple entries for the
 * same destination in a single tx.
 */
export function extractOutgoingDestinations(
  parsed: ParsedTransaction,
  userPubkey: string,
): string[] {
  const seen = new Set<string>();
  for (const inst of parsed.instructions) {
    let destination: string | undefined;

    if (inst.programId === SYSTEM_PROGRAM_ID) {
      // System Program uses a 4-byte u32 LE discriminator. Transfer = 2.
      if (inst.data.length >= 4) {
        const disc =
          inst.data[0] |
          (inst.data[1] << 8) |
          (inst.data[2] << 16) |
          (inst.data[3] * 0x1000000);
        if (disc === 2 && inst.accounts.length >= 2) {
          destination = inst.accounts[1];
        }
      }
    } else if (
      inst.programId === TOKEN_PROGRAM_ID ||
      inst.programId === TOKEN_2022_PROGRAM_ID
    ) {
      if (inst.data.length >= 1) {
        const disc = inst.data[0];
        if (disc === TOKEN_IX_TRANSFER && inst.accounts.length >= 2) {
          destination = inst.accounts[1];
        } else if (disc === TOKEN_IX_TRANSFER_CHECKED && inst.accounts.length >= 3) {
          destination = inst.accounts[2];
        }
      }
    }

    if (destination && destination !== userPubkey) {
      seen.add(destination);
    }
  }
  return [...seen];
}
