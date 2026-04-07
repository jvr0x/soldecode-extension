import { describe, it, expect } from "vitest";
import { mapError } from "@/lib/error-mapper";

describe("mapError", () => {
  it("maps slippage exceeded", () => {
    const result = mapError({ InstructionError: [2, { Custom: 6001 }] }, "JUPITER");
    expect(result.title).toBe("Slippage Exceeded");
    expect(result.fixes.length).toBeGreaterThan(0);
  });

  it("maps insufficient funds", () => {
    const result = mapError({ InstructionError: [0, "InsufficientFunds"] }, undefined);
    expect(result.title).toBe("Insufficient Funds");
  });

  it("maps blockhash not found", () => {
    const result = mapError("BlockhashNotFound", undefined);
    expect(result.title).toBe("Transaction Expired");
  });

  it("handles null gracefully", () => {
    const result = mapError(null, undefined);
    expect(result.title).toBe("Transaction Failed");
  });

  it("handles unknown custom error", () => {
    const result = mapError({ InstructionError: [0, { Custom: 99999 }] }, undefined);
    expect(result.rawError).toContain("99999");
  });
});
