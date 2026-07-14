// A tiny fake viem PublicClient for tests: dispatches readContract and
// simulateContract calls by functionName (handlers get the full call for
// per-address/per-args matching) and getBalance by address. Install with
// setRpcForTests(fakeClient(...)); reset with setRpcForTests(null).

export type FakeCall = { address: string; functionName: string; args?: readonly unknown[] };

export interface FakeChainState {
  balances?: Record<string, bigint>; // native ETH per address (lowercased)
  blockNumber?: bigint;
  reads?: Record<string, unknown | ((call: FakeCall) => unknown)>;
  simulations?: Record<string, unknown | ((call: FakeCall) => unknown)>;
}

export function fakeClient(state: FakeChainState) {
  return {
    calls: [] as FakeCall[],
    async getBalance({ address }: { address: string }) {
      return state.balances?.[address.toLowerCase()] ?? 0n;
    },
    async getBlockNumber() {
      return state.blockNumber ?? 1n;
    },
    async readContract(call: FakeCall) {
      this.calls.push(call);
      const handler = state.reads?.[call.functionName];
      if (handler === undefined) throw new Error(`fake-rpc: no read handler for ${call.functionName}`);
      return typeof handler === "function" ? (handler as (c: FakeCall) => unknown)(call) : handler;
    },
    async simulateContract(call: FakeCall) {
      this.calls.push(call);
      const handler = state.simulations?.[call.functionName];
      if (handler === undefined) throw new Error(`fake-rpc: no simulate handler for ${call.functionName}`);
      const result = typeof handler === "function" ? (handler as (c: FakeCall) => unknown)(call) : handler;
      return { result };
    },
  };
}

/** A fresh Chainlink latestRoundData tuple answering `usd` right now. */
export const feedRound = (usd: number, updatedAtSec = Math.floor(Date.now() / 1000)) =>
  [1n, BigInt(Math.round(usd * 1e8)), BigInt(updatedAtSec), BigInt(updatedAtSec), 1n] as const;
