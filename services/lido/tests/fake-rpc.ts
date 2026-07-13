// A tiny fake viem PublicClient for tests: dispatches readContract calls by
// functionName (with optional per-call matching) and getBalance by address.
// Install with setRpcForTests(fakeClient(...)); reset with setRpcForTests(null).

type ReadCall = { address: string; functionName: string; args?: readonly unknown[] };

export interface FakeChainState {
  balances?: Record<string, bigint>; // ETH per address (lowercased)
  reads: Record<string, unknown | ((call: ReadCall) => unknown)>;
}

export function fakeClient(state: FakeChainState) {
  return {
    calls: [] as ReadCall[],
    async getBalance({ address }: { address: string }) {
      return state.balances?.[address.toLowerCase()] ?? 0n;
    },
    async readContract(call: ReadCall) {
      this.calls.push(call);
      const handler = state.reads[call.functionName];
      if (handler === undefined) throw new Error(`fake-rpc: no handler for ${call.functionName}`);
      return typeof handler === "function" ? (handler as (c: ReadCall) => unknown)(call) : handler;
    },
  };
}

/** One withdrawal-request status tuple, shaped like viem returns it. */
export const wqStatus = (o: {
  amountOfStETH: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
  timestamp?: bigint;
  owner?: string;
}) => ({
  amountOfStETH: o.amountOfStETH,
  amountOfShares: o.amountOfStETH,
  owner: o.owner ?? "0x1111111111111111111111111111111111111111",
  timestamp: o.timestamp ?? 1_783_900_000n,
  isFinalized: o.isFinalized,
  isClaimed: o.isClaimed,
});
