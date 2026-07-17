// Small shared plumbing: the service-wide result envelope, the MCP response
// size budget, and human↔wei price conversion (listings are priced in native
// ETH — 18 decimals, always).

export interface OsResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export const ok = (data: unknown): OsResult => ({ ok: true, status: 200, data });
export const fail = (status: number, message: string): OsResult => ({ ok: false, status, data: message });

/** MCP responses get stuffed into a model context — keep them bounded. */
export const MAX_RESPONSE_CHARS = 24_000;

export function clip(data: unknown): unknown {
  const text = JSON.stringify(data);
  if (text.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ${MAX_RESPONSE_CHARS} chars (was ${text.length}). Ask a narrower question (smaller limit) for full detail.`,
    preview: text.slice(0, MAX_RESPONSE_CHARS),
  };
}

export const isEvmAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** "1.5" ETH → 1500000000000000000n. Null on malformed/zero/negative input. */
export function ethToWei(amount: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > 18) return null; // sub-wei precision would silently truncate
  const wei = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0") || "0");
  return wei > 0n ? wei : null;
}

/** Wei → human ETH string, trailing zeros trimmed ("1.5", not "1.500000..."). */
export function formatWei(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const base = 10n ** 18n;
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Positive integer token id / amount as a decimal string → bigint. */
export function parseUint(s: string): bigint | null {
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
