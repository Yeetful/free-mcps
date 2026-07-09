import { describe, expect, it } from "vitest";
import { awaitCompletion, checkStatus, notifyDeposit } from "@/lib/status";
import { DEPOSIT_ADDRESS, mockFetch, statusFixture } from "./fixtures";

const statusHandler =
  (fixture: unknown, status = 200) =>
  (url: string): { status?: number; body: unknown } | null =>
    url.includes("/v0/status") ? { status, body: fixture } : null;

describe("check_status", () => {
  it("explains every lifecycle state and points at the next step", async () => {
    const f = mockFetch(statusHandler(statusFixture("PENDING_DEPOSIT")));
    const r = await checkStatus(DEPOSIT_ADDRESS, { fetchImpl: f });
    expect(r.status).toBe("PENDING_DEPOSIT");
    expect(r.terminal).toBe(false);
    expect(r.explanation).toContain("waiting for funds");
    expect(r.next_step).toContain("signed");
  });

  it("carries both chains' explorer links on SUCCESS", async () => {
    const f = mockFetch(statusHandler(statusFixture("SUCCESS")));
    const r = await checkStatus(DEPOSIT_ADDRESS, { fetchImpl: f });
    expect(r.terminal).toBe(true);
    expect(r.swap.delivered).toBe("0.545");
    expect(r.swap.originTransactions[0].explorer).toContain("basescan");
    expect(r.swap.destinationTransactions[0].explorer).toContain("arbiscan");
    expect(r.next_step).toContain("destination transaction");
  });

  it("builds explorer links itself when the API returns empty explorerUrls (live behavior)", async () => {
    const fixture = statusFixture("SUCCESS");
    fixture.swapDetails.originChainTxHashes = [{ hash: "0xorigin", explorerUrl: "" }];
    fixture.swapDetails.destinationChainTxHashes = [{ hash: "0xdest", explorerUrl: "" }];
    const f = mockFetch(statusHandler(fixture));
    const r = await checkStatus(DEPOSIT_ADDRESS, { fetchImpl: f });
    expect(r.swap.originTransactions[0].explorer).toBe("https://basescan.org/tx/0xorigin");
    expect(r.swap.destinationTransactions[0].explorer).toBe("https://arbiscan.io/tx/0xdest");
  });

  it("reports refunds with the reason", async () => {
    const f = mockFetch(
      statusHandler(statusFixture("REFUNDED", { refundedAmountFormatted: "0.55", refundReason: "PARTIAL_DEPOSIT" })),
    );
    const r = await checkStatus(DEPOSIT_ADDRESS, { fetchImpl: f });
    expect(r.swap).toMatchObject({ refunded: "0.55", refundReason: "PARTIAL_DEPOSIT" });
  });

  it("explains a 404 as either a typo or a dry quote", async () => {
    const f = mockFetch(statusHandler({ message: "not found" }, 404));
    await expect(checkStatus(DEPOSIT_ADDRESS, { fetchImpl: f })).rejects.toThrow(/DRY preview/);
  });
});

describe("await_completion", () => {
  it("polls until the swap turns terminal", async () => {
    let calls = 0;
    const f = mockFetch((url) => {
      if (!url.includes("/v0/status")) return null;
      calls += 1;
      return { body: statusFixture(calls >= 3 ? "SUCCESS" : "PROCESSING") };
    });
    const r = await awaitCompletion({ depositAddress: DEPOSIT_ADDRESS, timeoutSec: 5, pollMs: 5 }, { fetchImpl: f });
    expect(r.status).toBe("SUCCESS");
    expect(r.terminal).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns calmly (not an error) when time runs out mid-flight", async () => {
    const f = mockFetch(statusHandler(statusFixture("PROCESSING")));
    const r = await awaitCompletion({ depositAddress: DEPOSIT_ADDRESS, timeoutSec: 5, pollMs: 400 }, { fetchImpl: f });
    expect(r.status).toBe("PROCESSING");
    expect(r.terminal).toBe(false);
    expect(r.note).toContain("normal");
  });
});

describe("submit_deposit_tx", () => {
  it("acknowledges the hash and points at await_completion", async () => {
    const f = mockFetch((url) => (url.includes("/v0/deposit/submit") ? { body: statusFixture("KNOWN_DEPOSIT_TX") } : null));
    const r = await notifyDeposit({ depositAddress: DEPOSIT_ADDRESS, txHash: "0xabc" }, { fetchImpl: f });
    expect(r.status).toBe("KNOWN_DEPOSIT_TX");
    expect(r.next_step).toContain("await_completion");
  });

  it("surfaces API rejections", async () => {
    const f = mockFetch((url) =>
      url.includes("/v0/deposit/submit") ? { status: 400, body: { message: "unknown deposit address" } } : null,
    );
    await expect(notifyDeposit({ depositAddress: "0xbad", txHash: "0xabc" }, { fetchImpl: f })).rejects.toThrow(
      /unknown deposit address/,
    );
  });
});
