import { describe, it, expect } from "vitest";
import { clip, formatAtoms, humanToAtoms, usdValue } from "@/lib/util";

describe("amount conversion (USDG is 6 decimals — the classic footgun)", () => {
  it("converts human USDG amounts at 6 decimals", () => {
    expect(humanToAtoms("100", 6)).toBe(100_000_000n);
    expect(humanToAtoms("0.5", 6)).toBe(500_000n);
    expect(humanToAtoms("1.5", 18)).toBe(1_500_000_000_000_000_000n);
  });

  it("rejects malformed, zero, and sub-atom amounts", () => {
    expect(humanToAtoms("abc", 6)).toBeNull();
    expect(humanToAtoms("-1", 6)).toBeNull();
    expect(humanToAtoms("0", 6)).toBeNull();
    expect(humanToAtoms("0.0000001", 6)).toBeNull(); // 7 fractional digits at 6 decimals
    expect(humanToAtoms("1e5", 6)).toBeNull();
  });

  it("round-trips through formatAtoms with trailing zeros trimmed", () => {
    expect(formatAtoms(1_500_000n, 6)).toBe("1.5");
    expect(formatAtoms(100_000_000n, 6)).toBe("100");
    expect(formatAtoms(1n, 18)).toBe("0.000000000000000001");
  });

  it("values atoms via an 8-decimal feed", () => {
    // 2 AAPL at $200.50
    expect(usdValue(2n * 10n ** 18n, 18, 200_50000000n, 8)).toBeCloseTo(401.0, 6);
    // 250 USDG at $0.9998 (6 decimals)
    expect(usdValue(250_000_000n, 6, 99_980_000n, 8)).toBeCloseTo(249.95, 6);
  });
});

describe("clip", () => {
  it("passes small payloads through and truncates huge ones", () => {
    expect(clip({ a: 1 })).toEqual({ a: 1 });
    const big = clip({ x: "y".repeat(30_000) }) as { note: string; preview: string };
    expect(big.note).toContain("truncated");
    expect(big.preview.length).toBeLessThanOrEqual(24_000);
  });
});
