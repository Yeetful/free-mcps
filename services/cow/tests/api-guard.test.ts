import { describe, it, expect } from "vitest";
import { guardApiGet } from "@/lib/api-guard";

const ADDR = "0x" + "a".repeat(40);
const UID = "0x" + "ab".repeat(56);
const HASH = "0x" + "cd".repeat(32);

describe("api_get guard (read-only escape hatch)", () => {
  it("passes every allowlisted read path", () => {
    for (const path of [
      `/v1/orders/${UID}`,
      `/v1/account/${ADDR}/orders`,
      `/v1/account/${ADDR}/orders?limit=10&offset=0`,
      `/v1/trades?owner=${ADDR}`,
      `/v1/trades?orderUid=${UID}`,
      `/v1/token/${ADDR}/native_price`,
      `/v1/app_data/${HASH}`,
      `/v1/users/${ADDR}/total_surplus`,
      "/v1/version",
      "/v2/solver_competition/latest",
      `/v2/solver_competition/by_tx_hash/${HASH}`,
    ]) {
      const r = guardApiGet(path);
      expect(r.ok, path).toBe(true);
    }
  });

  it("splits path from query correctly", () => {
    const r = guardApiGet(`/v1/trades?owner=${ADDR}`);
    expect(r).toMatchObject({ ok: true, path: "/v1/trades", query: `owner=${ADDR}` });
  });

  it("rejects write-shaped and unknown paths", () => {
    for (const path of [
      "/v1/orders", // POST target — no bare-orders GET
      "/v1/quote", // POST only
      "/v1/auction", // 403 upstream, deliberately excluded
      "/v1/solver_competition/latest", // moved to v2
      "/v1/version/extra",
      "/api/v1/version", // path is relative to /api already
      "v1/version", // must start with /
      `/v1/orders/${UID}/status-nope`,
      "/v9/version",
    ]) {
      expect(guardApiGet(path).ok, path).toBe(false);
    }
  });

  it("rejects traversal, whitespace, and doubled slashes", () => {
    expect(guardApiGet("/v1/../admin").ok).toBe(false);
    expect(guardApiGet("//v1/version").ok).toBe(false);
    expect(guardApiGet("/v1/version ?x=1").ok).toBe(false);
  });

  it("caps the query string and rejects nested markers", () => {
    expect(guardApiGet(`/v1/trades?owner=${ADDR}&pad=${"x".repeat(500)}`).ok).toBe(false);
    expect(guardApiGet("/v1/version?a=1?b=2").ok).toBe(false);
    expect(guardApiGet("/v1/version?a=%23#frag").ok).toBe(false);
  });

  it("rejects non-strings and empty", () => {
    expect(guardApiGet(42).ok).toBe(false);
    expect(guardApiGet("").ok).toBe(false);
  });

  it("helpful error lists the allowlist", () => {
    const r = guardApiGet("/v1/nope");
    expect(!r.ok && r.error).toContain("/v1/version");
  });
});
