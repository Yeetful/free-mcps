import { describe, it, expect } from "vitest";
import { guardInfoRequest, ALLOWED_INFO_TYPES } from "@/lib/info-guard";

describe("info_query guard (read-only allowlist)", () => {
  it("accepts an allowlisted user-data request", () => {
    expect(
      guardInfoRequest({ type: "userFees", user: "0x" + "1".repeat(40) }),
    ).toEqual({ ok: true });
  });

  it("accepts every documented read type", () => {
    for (const type of ALLOWED_INFO_TYPES) {
      expect(guardInfoRequest({ type }).ok).toBe(true);
    }
  });

  it("rejects non-objects and arrays", () => {
    expect(guardInfoRequest("userFees").ok).toBe(false);
    expect(guardInfoRequest(null).ok).toBe(false);
    expect(guardInfoRequest([{ type: "meta" }]).ok).toBe(false);
  });

  it("rejects a missing or non-string type", () => {
    expect(guardInfoRequest({}).ok).toBe(false);
    expect(guardInfoRequest({ type: 42 }).ok).toBe(false);
  });

  it("rejects types outside the allowlist (nothing exchange-shaped passes)", () => {
    for (const type of ["order", "cancel", "usdSend", "withdraw3", "notAThing"]) {
      const r = guardInfoRequest({ type });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("allowlist");
    }
  });

  it("rejects oversized bodies", () => {
    const r = guardInfoRequest({ type: "meta", junk: "x".repeat(3000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too large");
  });
});
