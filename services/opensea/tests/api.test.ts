import { afterEach, describe, expect, it } from "vitest";
import { setFetchForTests } from "@/lib/opensea-api";
import { accountNfts, bestListings, collectionInfo, collectionStats, nftDetail } from "@/lib/reads";
import { fetchRouter } from "./fakes";
import { accountNftsFixture, bestListingsFixture, collectionFixture, nftDetailFixture, statsFixture, OWNER, PENGUIN_CONTRACT } from "./fixtures";

afterEach(() => setFetchForTests(null));

describe("read shaping", () => {
  it("shapes account NFTs: image preferred from display_image_url, cursor passed through", async () => {
    setFetchForTests(fetchRouter([["/account/", accountNftsFixture]]));
    const r = await accountNfts("ethereum", OWNER, 20);
    expect(r.ok).toBe(true);
    const d = r.data as { count: number; nfts: { image_url: string | null; standard: string; collection: string }[]; next: string | null };
    expect(d.count).toBe(2);
    expect(d.nfts[0].image_url).toBe("https://i2c.seadn.io/ethereum/img/2489-display.png"); // display_ wins
    expect(d.nfts[1].image_url).toBe("https://raw2.seadn.io/ethereum/img/77.png"); // fallback
    expect(d.nfts[1].standard).toBe("erc1155");
    expect(d.next).toBe("cursor123");
  });

  it("refuses bad chains and bad addresses without calling the API", async () => {
    setFetchForTests(fetchRouter([])); // any call would 404 the fake
    expect((await accountNfts("solana", OWNER)).ok).toBe(false);
    expect((await accountNfts("ethereum", "not-an-address")).ok).toBe(false);
  });

  it("shapes NFT detail with owners + rarity", async () => {
    setFetchForTests(fetchRouter([["/nfts/2489", nftDetailFixture]]));
    const r = await nftDetail("ethereum", PENGUIN_CONTRACT, "2489");
    expect(r.ok).toBe(true);
    const d = r.data as { owners: { address: string }[]; rarity_rank: number; traits: unknown[] };
    expect(d.owners[0].address).toBe(OWNER);
    expect(d.rarity_rank).toBe(4596);
    expect(d.traits.length).toBe(1);
  });

  it("shapes collection info with the fee schedule", async () => {
    setFetchForTests(fetchRouter([["/collections/pudgypenguins", collectionFixture]]));
    const r = await collectionInfo("pudgypenguins");
    expect(r.ok).toBe(true);
    const d = r.data as { verified: boolean; fees: { percent: number; required: boolean }[] };
    expect(d.verified).toBe(true);
    expect(d.fees).toEqual([
      { percent: 1.0, recipient: "0x0000a26b00c1f0df003000390027140000faa719", required: true },
      { percent: 5.0, recipient: "0x1afa64e9b8e3090f2001f66d9c9a74cde646738a", required: false },
    ]);
  });

  it("shapes stats with floor price + one-day interval", async () => {
    setFetchForTests(fetchRouter([["/stats", statsFixture]]));
    const r = await collectionStats("pudgypenguins");
    expect(r.ok).toBe(true);
    const d = r.data as { floor_price: number; one_day: { sales: number } };
    expect(d.floor_price).toBe(4.35);
    expect(d.one_day.sales).toBe(25);
  });

  it("shapes best listings with human ETH prices + order hashes", async () => {
    setFetchForTests(fetchRouter([["/listings/collection/", bestListingsFixture]]));
    const r = await bestListings("pudgypenguins", 5);
    expect(r.ok).toBe(true);
    const d = r.data as { listings: { price_eth: string; order_hash: string; identifier: string }[] };
    expect(d.listings[0].price_eth).toBe("4.4");
    expect(d.listings[0].identifier).toBe("2489");
    expect(d.listings[0].order_hash).toMatch(/^0x38defb/);
  });

  it("fails honestly when the API key is missing", async () => {
    const saved = process.env.OPENSEA_API_KEY;
    delete process.env.OPENSEA_API_KEY;
    try {
      const r = await accountNfts("ethereum", OWNER);
      expect(r.ok).toBe(false);
      expect(String(r.data)).toContain("OPENSEA_API_KEY");
    } finally {
      process.env.OPENSEA_API_KEY = saved;
    }
  });
});
