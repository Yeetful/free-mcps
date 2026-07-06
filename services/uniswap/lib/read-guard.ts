// Guardrails for the raw contract-read escape hatch (`read_contract` tool).
//
// Base is a public chain and eth_call is read-only BY CONSTRUCTION — a call
// can never move funds, sign, or change state. So (like snapshot's
// graphql-guard) the risk of exposing it is hosting abuse of our RPC budget,
// not safety. The guard is structural: parse the signature with viem's
// reference parser and enforce shape — read-only mutability, bounded args,
// coerced/validated values, truncated responses. Never sanitize with regexes.
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbiItem,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import {
  QUOTER_V2,
  readRetry,
  rpc,
  SWAP_ROUTER_02,
  V3_FACTORY,
  V4_POOL_MANAGER,
  V4_STATE_VIEW,
  WETH,
} from "./chain";

/** Planner-friendly names for the contracts this service is built on. Any
 *  other 0x address (pools, tokens) is equally fine — eth_call is harmless. */
export const KNOWN_CONTRACTS: Record<string, `0x${string}`> = {
  v3_factory: V3_FACTORY,
  quoter_v2: QUOTER_V2,
  swap_router_02: SWAP_ROUTER_02,
  v4_state_view: V4_STATE_VIEW,
  v4_pool_manager: V4_POOL_MANAGER,
  weth: WETH,
};

const MAX_SIGNATURE_CHARS = 400;
const MAX_ARGS = 12;
export const MAX_RESPONSE_CHARS = 24_000;

/** Resolve a known-contract name or checksum a raw address. Throws legibly. */
export function resolveContract(contract: string): `0x${string}` {
  const named = KNOWN_CONTRACTS[contract.trim().toLowerCase()];
  if (named) return named;
  if (isAddress(contract.trim())) return getAddress(contract.trim());
  throw new Error(
    `Unknown contract "${contract}". Pass a 0x address or one of: ${Object.keys(KNOWN_CONTRACTS).join(", ")}.`,
  );
}

/** Parse a human-readable Solidity signature into an ABI function and refuse
 *  anything that is not a read. `function ` prefix is optional. nonpayable is
 *  allowed — quoter-style simulations are nonpayable but run via eth_call,
 *  which cannot change state. */
export function parseSignature(signature: string): AbiFunction {
  const sig = signature.trim();
  if (sig.length > MAX_SIGNATURE_CHARS) {
    throw new Error(`Signature is ${sig.length} chars (max ${MAX_SIGNATURE_CHARS}).`);
  }
  let item;
  try {
    item = parseAbiItem(sig.startsWith("function ") ? sig : `function ${sig}`);
  } catch (e) {
    throw new Error(
      `Could not parse signature: ${e instanceof Error ? e.message : String(e)}. Expected e.g. "function balanceOf(address) view returns (uint256)".`,
    );
  }
  if (item.type !== "function") {
    throw new Error(`Only function signatures are readable (got ${item.type}).`);
  }
  if (item.stateMutability === "payable") {
    throw new Error(
      "Payable functions are not reads. This tool only simulates via eth_call — use build_swap / build_wrap for transactions.",
    );
  }
  return item;
}

/** Coerce one JSON value to what viem's ABI encoder expects for `param`.
 *  JSON has no bigint and planners pass numbers as strings — accept both. */
function coerceArg(param: AbiParameter, value: unknown, path: string): unknown {
  const t = param.type;
  const arrayMatch = t.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array for type ${t}.`);
    if (arrayMatch[2] && value.length !== Number(arrayMatch[2])) {
      throw new Error(`${path} needs exactly ${arrayMatch[2]} items for type ${t} (got ${value.length}).`);
    }
    const inner = { ...param, type: arrayMatch[1] } as AbiParameter;
    return value.map((v, i) => coerceArg(inner, v, `${path}[${i}]`));
  }
  if (t === "tuple") {
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    const values = Array.isArray(value)
      ? value
      : components.map((c, i) => (value as Record<string, unknown>)?.[c.name ?? String(i)]);
    if (!Array.isArray(value) && (typeof value !== "object" || value === null)) {
      throw new Error(`${path} must be an object or array for a tuple.`);
    }
    if (values.length !== components.length) {
      throw new Error(`${path} needs ${components.length} tuple fields (got ${values.length}).`);
    }
    // viem accepts positional arrays for tuples; keeps unnamed components easy.
    return components.map((c, i) => coerceArg(c, values[i], `${path}.${c.name ?? i}`));
  }
  if (/^u?int\d*$/.test(t)) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    throw new Error(`${path} must be an integer (number or decimal string) for type ${t}.`);
  }
  if (t === "address") {
    if (typeof value !== "string" || !isAddress(value.trim())) {
      throw new Error(`${path} must be a 0x address for type address.`);
    }
    return getAddress(value.trim());
  }
  if (t === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    throw new Error(`${path} must be a boolean for type bool.`);
  }
  if (t === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    return value;
  }
  if (t.startsWith("bytes")) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value.trim())) {
      throw new Error(`${path} must be 0x-prefixed hex for type ${t}.`);
    }
    return value.trim();
  }
  throw new Error(`${path}: unsupported ABI type ${t}.`);
}

export interface ReadCall {
  to: `0x${string}`;
  data: `0x${string}`;
  fn: AbiFunction;
}

/** Pure step: validate contract + signature + args and encode the calldata.
 *  Everything that can be unit-tested without a network lives here. */
export function buildReadCall(input: { contract: string; signature: string; args?: unknown[] }): ReadCall {
  const to = resolveContract(input.contract);
  const fn = parseSignature(input.signature);
  const args = input.args ?? [];
  if (args.length > MAX_ARGS) throw new Error(`Too many args (${args.length}, max ${MAX_ARGS}).`);
  if (args.length !== fn.inputs.length) {
    throw new Error(
      `"${fn.name}" takes ${fn.inputs.length} argument(s) (${fn.inputs.map((i) => i.type).join(", ") || "none"}) — got ${args.length}.`,
    );
  }
  const coerced = fn.inputs.map((param, i) => coerceArg(param, args[i], `args[${i}] (${param.name ?? param.type})`));
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerced });
  return { to, data, fn };
}

/** Serialize a decoded result for the wire: bigints become strings, and the
 *  whole payload is truncated like snapshot's escape hatch. */
export function presentResult(fn: AbiFunction, raw: unknown): unknown {
  const jsonSafe = JSON.parse(
    JSON.stringify(raw ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  const result =
    fn.outputs.length <= 1
      ? { [fn.outputs[0]?.name || "result"]: jsonSafe }
      : Object.fromEntries(fn.outputs.map((o, i) => [o.name || `output${i}`, (jsonSafe as unknown[])[i]]));
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_RESPONSE_CHARS) {
    return {
      truncated: true,
      note: `Result truncated to ~${MAX_RESPONSE_CHARS} chars — read a narrower function. \`preview\` is a raw (clipped) JSON string.`,
      preview: serialized.slice(0, MAX_RESPONSE_CHARS),
    };
  }
  return result;
}

/** Execute a guarded read: build calldata, eth_call it (with the shared
 *  rate-limit retry), decode against the caller's signature. */
export async function executeRead(input: { contract: string; signature: string; args?: unknown[] }) {
  const { to, data, fn } = buildReadCall(input);
  const { data: returned } = await readRetry(() => rpc().call({ to, data }));
  if (!returned || returned === "0x") {
    throw new Error(
      `"${fn.name}" returned no data from ${to} — wrong contract, wrong signature, or the function reverted.`,
    );
  }
  const decoded = fn.outputs.length === 0 ? null : decodeFunctionResult({ abi: [fn], functionName: fn.name, data: returned });
  return {
    chainId: 8453,
    contract: to,
    function: fn.name,
    result: presentResult(fn, decoded),
  };
}
