// Live smoke against the real Lido contracts + public APIs (zero spend by
// construction — reads + transaction PREPARATION only; nothing is ever signed
// or submitted). Usage: pnpm smoke [address]
// Verifies: stats (incl. cross-checking stETH's address against eth-api's
// response meta), APR, position, earnings, withdrawals, convert round-trip,
// queue wait estimate, and every build_* wrapper (construct-only: the
// returned calldata is never sent anywhere).
import { formatEther, parseEther } from "viem";
import { STETH, WSTETH, WITHDRAWAL_QUEUE, WITHDRAWAL_QUEUE_ABI, readRetry, rpc } from "../lib/chain";
import { fetchApr, fetchQueueWait, type AprInfo } from "../lib/lido-api";
import { reads } from "../lib/reads";
import { builds, type SendTransactionAction } from "../lib/tx";

// Default probe address: vitalik.eth — holds live (dust) stETH AND wstETH,
// with 258 reward events in the history API (verified 2026-07-13).
const USER = (process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045") as `0x${string}`;

let failures = 0;

async function check(name: string, fn: () => Promise<{ pass: boolean; detail: string }>) {
  try {
    const { pass, detail } = await fn();
    console.log(`${pass ? "✅" : "❌"} ${name} — ${detail}`);
    if (!pass) failures++;
  } catch (e) {
    console.log(`❌ ${name} — threw: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }
}

const dig = <T,>(r: { ok: boolean; data: unknown }): T => r.data as T;

async function main() {
  console.log(`Lido MCP live smoke — probe address ${USER}\n`);

  await check("apr API (address meta cross-check)", async () => {
    const r = await fetchApr();
    const d = dig<AprInfo>(r);
    // Cross-check: eth-api's meta pins stETH's address — compare to ours.
    const raw = await fetch("https://eth-api.lido.fi/v1/protocol/steth/apr/last").then((x) => x.json());
    const metaAddr = (raw?.meta?.address ?? "").toLowerCase();
    return {
      pass: r.ok && d.smaAprPct !== null && d.smaAprPct > 0 && d.smaAprPct < 20 && metaAddr === STETH.toLowerCase(),
      detail: `SMA ${d.smaAprPct}% / latest ${d.latestAprPct}% — API meta address ${metaAddr === STETH.toLowerCase() ? "matches" : "MISMATCH"}`,
    };
  });

  await check("stats", async () => {
    const r = await reads.stats();
    const d = dig<Record<string, any>>(r);
    return {
      pass: r.ok && Number(d.totalStakedEth) > 1_000_000 && Number(d.stEthPerWstEth) > 1,
      detail: `${d.totalStakedEth} ETH staked, rate ${d.stEthPerWstEth}, queue pending ${d.withdrawalQueue?.pendingRequests}`,
    };
  });

  await check("position (probe address)", async () => {
    const r = await reads.position(USER);
    const d = dig<Record<string, any>>(r);
    return {
      pass: r.ok && d.stEth?.balance !== undefined && d.wstEth?.asStEth !== undefined,
      detail: `stETH ${d.stEth?.balance}, wstETH ${d.wstEth?.balance} (=${d.wstEth?.asStEth} stETH), total staked ${d.totalStaked?.stEth} ($${d.totalStaked?.usd ?? "?"})`,
    };
  });

  await check("earnings (reward history)", async () => {
    const r = await reads.earnings({ user: USER, limit: 5 });
    const d = dig<Record<string, any>>(r);
    return {
      pass: r.ok && (d.rewardEvents > 0 ? Number(d.totalRewards?.stEth) > 0 && d.recentRewards?.length > 0 : true),
      detail: `${d.rewardEvents ?? 0} reward events, total ${d.totalRewards?.stEth} stETH ($${d.totalRewards?.usd}), avg APR ${d.averageAprPct}%`,
    };
  });

  await check("withdrawals view", async () => {
    const r = await reads.withdrawals(USER);
    const d = dig<Record<string, any>>(r);
    return {
      pass: r.ok && Array.isArray(d.requests) && d.queue?.lastRequestId !== undefined,
      detail: `${d.requests.length} requests for probe addr; queue last id ${d.queue?.lastRequestId}, unfinalized ${d.queue?.unfinalizedStEth} stETH`,
    };
  });

  await check("queue wait estimate (1 stETH)", async () => {
    const r = await fetchQueueWait("1");
    const d = dig<Record<string, any>>(r);
    return { pass: r.ok && d.estimatedWaitHours !== null, detail: `~${d.estimatedWaitHours}h → ${d.estimatedFinalizationAt}` };
  });

  await check("convert round-trip", async () => {
    const toWst = await reads.convert({ amount: "10", from: "stETH", to: "wstETH" });
    const back = await reads.convert({ amount: dig<{ result: string }>(toWst).result, from: "wstETH", to: "stETH" });
    const out = Number(dig<{ result: string }>(back).result);
    return { pass: toWst.ok && back.ok && Math.abs(out - 10) < 0.001, detail: `10 stETH → ${dig<{ result: string }>(toWst).result} wstETH → ${out} stETH` };
  });

  // ── build_* (construction-only; calldata never leaves this process) ──────
  const isSteps = (r: { ok: boolean; data: unknown }) =>
    r.ok && (r.data as { steps: SendTransactionAction[] }).steps.every((s) => s.action === "send_transaction" && s.tx.chainId === 1);

  await check("build_stake (0.01 ETH → stETH)", async () => {
    const r = await builds.stake({ user: USER, amount: "0.01" });
    const s = (r.data as { steps: SendTransactionAction[] }).steps?.[0];
    return { pass: isSteps(r) && s.tx.to === STETH && s.tx.value === parseEther("0.01").toString(), detail: r.ok ? `1 step → ${s.tx.to} value ${s.tx.value}` : String(r.data) };
  });

  await check("build_stake (→ wstETH direct)", async () => {
    const r = await builds.stake({ user: USER, amount: "0.01", receive: "wstETH" });
    const s = (r.data as { steps: SendTransactionAction[] }).steps?.[0];
    return { pass: isSteps(r) && s.tx.to === WSTETH && s.tx.data === "0x", detail: r.ok ? `plain transfer to wstETH` : String(r.data) };
  });

  await check("build_stake refuses over-balance honestly", async () => {
    const r = await builds.stake({ user: USER, amount: "99999999" });
    return { pass: !r.ok && String(r.data).includes("Insufficient ETH"), detail: String(r.data).slice(0, 90) };
  });

  await check("build_wrap (dust, live allowance read)", async () => {
    // vitalik holds dust stETH — wrap half of it so balance always covers.
    const pos = await reads.position(USER);
    const bal = Number((pos.data as any)?.stEth?.balance ?? 0);
    if (bal <= 0) return { pass: true, detail: "probe addr holds no stETH — skipped (covered by unit tests)" };
    const amt = (bal / 2).toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
    const r = await builds.wrap({ user: USER, amount: amt });
    const steps = (r.data as { steps: SendTransactionAction[] }).steps ?? [];
    return { pass: isSteps(r), detail: r.ok ? `${steps.length} step(s): ${steps.map((s) => s.label).join(" → ")}` : String(r.data) };
  });

  await check("build_unwrap (max on live balance)", async () => {
    const r = await builds.unwrap({ user: USER, max: true });
    const steps = (r.data as { steps: SendTransactionAction[] }).steps ?? [];
    return { pass: isSteps(r) && steps[0].tx.to === WSTETH, detail: r.ok ? `unwraps full wstETH balance` : String(r.data) };
  });

  await check("build_request_withdrawal refuses dust below queue MIN", async () => {
    // vitalik's stETH is ~10^-5 — fine; use an explicit sub-100-wei ask.
    const r = await builds.requestWithdrawal({ user: USER, amount: "0.00000000000000005" });
    return { pass: !r.ok && String(r.data).includes("minimum"), detail: String(r.data).slice(0, 80) };
  });

  await check("build_request_withdrawal (dust stETH, live)", async () => {
    const r = await builds.requestWithdrawal({ user: USER, max: true });
    if (!r.ok) {
      // A probe address with < MIN stETH gets the honest refusal — also a pass.
      return { pass: /minimum|holds no/.test(String(r.data)), detail: String(r.data).slice(0, 90) };
    }
    const steps = (r.data as { steps: SendTransactionAction[] }).steps;
    return { pass: isSteps(r) && steps.at(-1)!.tx.to === WITHDRAWAL_QUEUE, detail: `${steps.length} step(s): ${steps.map((s) => s.label).join(" → ")}` };
  });

  await check("build_claim (honest when nothing claimable)", async () => {
    const r = await builds.claim({ user: USER });
    if (r.ok) {
      const steps = (r.data as { steps: SendTransactionAction[] }).steps;
      return { pass: isSteps(r), detail: `claimable! ${steps.length} step(s)` };
    }
    return { pass: /nothing to claim|pending finalization|already claimed/.test(String(r.data)), detail: String(r.data).slice(0, 90) };
  });

  await check("queue contract limits match pinned constants", async () => {
    const client = rpc();
    const [min, max] = await Promise.all([
      readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "MIN_STETH_WITHDRAWAL_AMOUNT" })),
      readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "MAX_STETH_WITHDRAWAL_AMOUNT" })),
    ]);
    return { pass: min === 100n && formatEther(max) === "1000", detail: `MIN ${min} wei, MAX ${formatEther(max)} ETH` };
  });

  console.log(`\n${failures === 0 ? "✅ all smoke checks passed" : `❌ ${failures} smoke check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
