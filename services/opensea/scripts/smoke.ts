// Live, ZERO-SPEND smoke: verifies every registry pin against real chains
// and the real OpenSea API, and exercises every build path expecting either
// an artifact or an honest refusal. Needs OPENSEA_API_KEY. Usage:
//   pnpm smoke [address]     (default probe wallet: vitalik.eth)
import { CHAINS, OPENSEA_CONDUIT, SEAPORT_1_6 } from "../lib/registry";
import { SEAPORT_ABI, readRetry, rpc } from "../lib/chain";
import { accountNfts, bestListings, collectionInfo, collectionStats, nftDetail } from "../lib/reads";
import { buildBuyNft, buildListing, buildTransferNft } from "../lib/tx";

const PROBE = (process.argv[2] as `0x${string}`) ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const DEAD = "0x000000000000000000000000000000000000dEaD";

let failures = 0;
async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function main() {
  console.log(`opensea smoke — probe wallet ${PROBE}\n`);

  console.log("registry pins:");
  for (const chain of CHAINS) {
    await check(`${chain.slug}: Seaport 1.6 + conduit deployed, getCounter answers`, async () => {
      const client = rpc(chain.slug);
      const [seaportCode, conduitCode] = await Promise.all([
        readRetry(() => client.getCode({ address: SEAPORT_1_6 })),
        readRetry(() => client.getCode({ address: OPENSEA_CONDUIT })),
      ]);
      assert(seaportCode && seaportCode !== "0x", "no Seaport bytecode");
      assert(conduitCode && conduitCode !== "0x", "no conduit bytecode");
      const counter = await readRetry(() =>
        client.readContract({ address: SEAPORT_1_6, abi: SEAPORT_ABI, functionName: "getCounter", args: [PROBE] }),
      );
      return `counter(probe)=${counter}`;
    });
  }

  console.log("\nreads:");
  let anyNft: { contract: string; identifier: string; collection: string } | null = null;
  await check("get_account_nfts (ethereum)", async () => {
    const r = await accountNfts("ethereum", PROBE, 5);
    assert(r.ok, String(r.data));
    const d = r.data as { count: number; nfts: { contract: string; identifier: string; collection: string; image_url: string | null }[] };
    if (d.nfts[0]) anyNft = d.nfts[0];
    return `${d.count} NFTs, first image ${d.nfts[0]?.image_url ? "present" : "absent"}`;
  });
  await check("get_collection + stats + best listings (pudgypenguins)", async () => {
    const [c, s, l] = await Promise.all([collectionInfo("pudgypenguins"), collectionStats("pudgypenguins"), bestListings("pudgypenguins", 3)]);
    assert(c.ok && s.ok && l.ok, `collection=${c.status} stats=${s.status} listings=${l.status}`);
    const fees = (c.data as { fees: { required: boolean }[] }).fees;
    assert(fees.some((f) => f.required), "no required fee in schedule");
    const floor = (s.data as { floor_price: number | null }).floor_price;
    const listings = (l.data as { listings: { order_hash: string; price_eth: string | null }[] }).listings;
    assert(listings.length > 0, "no live listings");
    return `floor ${floor} ETH, cheapest ${listings[0].price_eth} ETH`;
  });
  await check("get_nft detail (probe wallet's first NFT)", async () => {
    assert(anyNft, "probe wallet had no NFTs to detail");
    const r = await nftDetail("ethereum", anyNft!.contract, anyNft!.identifier);
    assert(r.ok, String(r.data));
    return `${(r.data as { name: string | null }).name ?? anyNft!.identifier}`;
  });

  console.log("\nbuild paths (artifact or honest refusal — never a signature):");
  await check("build_transfer_nft refuses a non-owned NFT", async () => {
    const r = await buildTransferNft("ethereum", "0xbd3531da5cf5857e7cfaa92426877b022e612cf8", "2489", DEAD, PROBE, "1");
    assert(!r.ok && String(r.data).includes("Nothing was built"), `expected refusal, got ${JSON.stringify(r.data).slice(0, 120)}`);
    return "refused (dead wallet doesn't own Pudgy #2489)";
  });
  await check("build_listing refuses a non-owned NFT", async () => {
    const r = await buildListing("ethereum", "0xbd3531da5cf5857e7cfaa92426877b022e612cf8", "2489", DEAD, "10", 24, "1", false);
    assert(!r.ok && String(r.data).includes("Nothing was built"), `expected refusal, got ${JSON.stringify(r.data).slice(0, 120)}`);
    return "refused";
  });
  await check("build_buy_nft produces real calldata then refuses at a 0.000001 ETH cap", async () => {
    const l = await bestListings("pudgypenguins", 1);
    assert(l.ok, String(l.data));
    const hash = (l.data as { listings: { order_hash: string }[] }).listings[0]?.order_hash;
    assert(hash, "no live listing to probe");
    const r = await buildBuyNft("ethereum", hash, PROBE, "0.000001");
    assert(!r.ok && String(r.data).includes("cap"), `expected price-cap refusal, got ${JSON.stringify(r.data).slice(0, 160)}`);
    return "fulfillment fetched, calldata path exercised, cap refused";
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall green");
  process.exit(failures ? 1 : 0);
}

main();
