import { afterEach, describe, expect, it } from "vitest";
import { setRpcForTests } from "@/lib/chain";
import { reads } from "@/lib/reads";
import { resolveToken } from "@/lib/registry";
import { fakeClient, feedRound, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const TSLA = resolveToken("TSLA")!;

afterEach(() => setRpcForTests(null));

describe("portfolio", () => {
  it("values holdings via Chainlink and returns the rich-card shape", async () => {
    setRpcForTests(
      fakeClient({
        balances: { [USER.toLowerCase()]: 0n },
        reads: {
          balanceOf: (c: FakeCall) => (c.address.toLowerCase() === TSLA.address.toLowerCase() ? 2n * 10n ** 18n : 0n),
          latestRoundData: (c: FakeCall) => {
            if (c.address.toLowerCase() === TSLA.feed!.toLowerCase()) return feedRound(300);
            throw new Error("unexpected feed");
          },
        },
      }),
    );
    const res = await reads.portfolio({ user: USER });
    expect(res.ok).toBe(true);
    const data = res.data as { kind: string; totalUsd: number; holdings: Array<{ symbol: string; balance: string; usd: number }> };
    expect(data.kind).toBe("portfolio");
    expect(data.holdings).toHaveLength(1);
    expect(data.holdings[0]).toMatchObject({ symbol: "TSLA", balance: "2" });
    expect(data.totalUsd).toBeCloseTo(600, 2);
  });
});

describe("token_info / prices", () => {
  it("404s on unknown tokens", async () => {
    setRpcForTests(fakeClient({ reads: {} }));
    expect((await reads.tokenInfo({ token: "DOGE" })).status).toBe(404);
    expect((await reads.prices({ tokens: ["TSLA", "NOPE"] })).status).toBe(404);
  });

  it("flags a stale feed and a paused oracle", async () => {
    const staleAt = Math.floor(Date.now() / 1000) - 200_000; // way past heartbeat
    setRpcForTests(
      fakeClient({
        reads: {
          latestRoundData: feedRound(300, staleAt),
          totalSupply: 10n ** 24n,
          uiMultiplier: 10n ** 18n,
          newUIMultiplier: 10n ** 18n,
          effectiveAt: 0n,
          oraclePaused: false,
        },
      }),
    );
    const res = await reads.tokenInfo({ token: "TSLA" });
    expect(res.ok).toBe(true);
    expect((res.data as { price: { stale: boolean } }).price.stale).toBe(true);

    setRpcForTests(
      fakeClient({
        reads: {
          latestRoundData: feedRound(300),
          totalSupply: 10n ** 24n,
          uiMultiplier: 10n ** 18n,
          newUIMultiplier: 10n ** 18n,
          effectiveAt: 0n,
          oraclePaused: true,
        },
      }),
    );
    const paused = await reads.tokenInfo({ token: "TSLA" });
    expect(paused.ok).toBe(true);
    const price = (paused.data as { price: { usd: number | null; note?: string } }).price;
    expect(price.usd).toBeNull();
    expect(price.note).toContain("Corporate action");
  });
});
