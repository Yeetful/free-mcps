// The movable-money scan — ported from services/yeetful-tool-funding/lib/
// plan.ts (scanFundingSources), trimmed to what the handoff surface needs.
// failedChains means UNKNOWN, never empty: a 429'd RPC once hid a $15k
// balance, so partial scans never claim a chain holds nothing.

import { erc20Abi, formatEther, formatUnits } from "viem";
import { SCAN_CHAINS, clientFor, ethUsd } from "./chains";

export interface WalletHolding {
  chainId: number;
  chain: string;
  token: "ETH" | "USDC";
  balance: number;
  /** USD value; ETH rows are 0 when the price probe failed (see priced). */
  usd: number;
}

export interface WalletScan {
  holdings: WalletHolding[];
  readChains: string[];
  failedChains: string[];
  /** False when the ETH/USD probe failed — ETH rows are then unpriced. */
  priced: boolean;
  note: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ETH + USDC across Base/Arbitrum/Ethereum, gas-reserve aware. */
export async function scanWallet(user: `0x${string}`): Promise<WalletScan> {
  const px = await ethUsd();
  const holdings: WalletHolding[] = [];
  const readChains: string[] = [];
  const failedChains: string[] = [];
  await Promise.all(
    SCAN_CHAINS.map(async (c) => {
      const client = clientFor(c.chainId);
      if (!client) return;
      const read = () =>
        Promise.all([
          client.getBalance({ address: user }),
          client.readContract({ address: c.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
        ]);
      try {
        const [nativeWei, usdcAtoms] = await read().catch(async () => {
          await sleep(400);
          return read();
        });
        readChains.push(c.word);
        const nativeEth = Number(formatEther(nativeWei));
        const usdcBal = Number(formatUnits(usdcAtoms, c.usdc.decimals));
        if (usdcBal > 0 && nativeEth >= c.minGasToSendEth) {
          holdings.push({ chainId: c.chainId, chain: c.word, token: "USDC", balance: usdcBal, usd: usdcBal });
        }
        const movableEth = nativeEth - c.gasReserveEth;
        if (movableEth > 0) {
          holdings.push({ chainId: c.chainId, chain: c.word, token: "ETH", balance: movableEth, usd: px ? movableEth * px : 0 });
        }
      } catch {
        failedChains.push(c.word);
      }
    }),
  );
  if (readChains.length === 0) throw new Error("No scan chain was readable — try again in a moment.");
  return {
    holdings,
    readChains,
    failedChains,
    priced: px != null,
    note:
      failedChains.length > 0
        ? `Chains [${failedChains.join(", ")}] could not be read — treat them as UNKNOWN, never as empty.`
        : "All covered chains read. Robinhood Chain (4663) balances ride the robinhood MCP instead.",
  };
}
