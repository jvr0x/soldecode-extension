import { describe, it, expect } from "vitest";
import { parseInstructionLogs } from "@/lib/instruction-parser";

describe("parseInstructionLogs", () => {
  it("extracts top-level program invocations", () => {
    const logs = [
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
      "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [2]",
      "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success",
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
    ];
    const steps = parseInstructionLogs(logs);
    expect(steps.length).toBe(1);
    expect(steps[0].description).toContain("Jupiter v6");
    expect(steps[0].program).toBe("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  });

  it("handles multiple top-level programs", () => {
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
    ];
    const steps = parseInstructionLogs(logs);
    expect(steps.length).toBe(2);
    expect(steps[0].description).toContain("Compute Budget");
    expect(steps[1].description).toContain("Jupiter v6");
  });

  it("returns empty for empty logs", () => {
    expect(parseInstructionLogs([]).length).toBe(0);
  });

  it("truncates unknown program addresses", () => {
    const logs = [
      "Program AbCd1234567890abcdef1234567890abcdefAbCdEf12 invoke [1]",
      "Program AbCd1234567890abcdef1234567890abcdefAbCdEf12 success",
    ];
    const steps = parseInstructionLogs(logs);
    expect(steps[0].description).toContain("AbCd");
    expect(steps[0].description).toContain("Ef12");
  });
});
