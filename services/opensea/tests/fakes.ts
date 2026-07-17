// Test doubles: a URL-routed fetch fake for the OpenSea API and a
// functionName-dispatched RPC fake for the viem client seam.

type Handler = (url: string, init?: RequestInit) => unknown;

/** Route fetches by URL substring → JSON body (or a thrown Error). */
export function fetchRouter(routes: [string, Handler | unknown][]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [needle, handler] of routes) {
      if (!url.includes(needle)) continue;
      const body = typeof handler === "function" ? (handler as Handler)(url, init) : handler;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ errors: [`no fake route for ${url}`] }), { status: 404 });
  }) as typeof fetch;
}

export interface RpcFakeState {
  /** ERC-721 tokenId → owner. */
  owners?: Record<string, string>;
  /** ERC-1155 `${account}:${id}` → balance. */
  balances1155?: Record<string, bigint>;
  /** `${owner}:${operator}` → approved-for-all. */
  approvals?: Record<string, boolean>;
  /** Seaport getCounter answer. */
  counter?: bigint;
  /** getBalance answer (native ETH). */
  ethBalance?: bigint;
  /** When true, ownerOf reverts (contract is not ERC-721). */
  not721?: boolean;
}

export function rpcFake(state: RpcFakeState) {
  return {
    async readContract({ functionName, args }: { functionName: string; args: unknown[] }) {
      switch (functionName) {
        case "ownerOf": {
          if (state.not721) throw new Error("execution reverted");
          const owner = state.owners?.[String(args[0])];
          if (!owner) throw new Error("ERC721: invalid token ID");
          return owner;
        }
        case "balanceOf":
          return state.balances1155?.[`${String(args[0]).toLowerCase()}:${String(args[1])}`] ?? 0n;
        case "isApprovedForAll":
          return state.approvals?.[`${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`] ?? false;
        case "getCounter":
          return state.counter ?? 0n;
        default:
          throw new Error(`rpcFake: unhandled read ${functionName}`);
      }
    },
    async getBalance() {
      return state.ethBalance ?? 0n;
    },
  };
}
