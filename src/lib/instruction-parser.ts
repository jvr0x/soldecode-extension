import type { PreviewStep } from "@/types";
import { KNOWN_PROGRAMS } from "./constants";

/**
 * Parses simulation log lines into human-readable preview steps.
 * Only extracts top-level program invocations (invoke [1]).
 * Nested CPI calls (invoke [2], [3], etc.) are intentionally skipped
 * to keep the step list concise and user-facing.
 */
export function parseInstructionLogs(logs: string[]): PreviewStep[] {
  const steps: PreviewStep[] = [];
  let stepIndex = 1;

  for (const log of logs) {
    // Match only top-level invocations: "Program <address> invoke [1]"
    const invokeMatch = log.match(/^Program (\S+) invoke \[1\]$/);
    if (invokeMatch) {
      const programId = invokeMatch[1];
      // Reason: Unknown programs are truncated to first/last 4 chars so the
      // UI stays readable without exposing an unformatted 44-char address.
      const programName =
        KNOWN_PROGRAMS[programId] ??
        `${programId.slice(0, 4)}...${programId.slice(-4)}`;
      steps.push({
        index: stepIndex++,
        description: `Execute ${programName}`,
        program: programId,
      });
    }
  }

  return steps;
}
