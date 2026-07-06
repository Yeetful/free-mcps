// Runs against the REAL committed corpus (lib/docs-data.json) so a bad
// regeneration breaks the build, not production.
import { describe, it, expect } from "vitest";
import { getDocPage, loadCorpus, searchDocs, setCorpusForTests } from "@/lib/docs";

describe("bundled docs corpus (real data)", () => {
  it("loads a substantial corpus", async () => {
    const pages = await loadCorpus();
    expect(pages.length).toBeGreaterThan(80);
    for (const p of pages.slice(0, 10)) {
      expect(p.path).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.text.length).toBeGreaterThan(50);
    }
    // Page + corpus budgets hold.
    expect(Math.max(...pages.map((p) => p.text.length))).toBeLessThanOrEqual(12_100);
    expect(JSON.stringify(pages).length).toBeLessThanOrEqual(3_500_000);
  });

  it("finds the signing-schemes page for an EIP-712 question", async () => {
    const hits = await searchDocs("EIP-712 order signing domain separator");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.path)).toContain("cow-protocol/reference/core/signing_schemes");
    expect(hits[0]!.snippets.length).toBeGreaterThan(0);
  });

  it("answers 'how does CoW protect against MEV'", async () => {
    const hits = await searchDocs("MEV protection batch auction");
    expect(hits.length).toBeGreaterThan(0);
    const joined = hits.map((h) => (h.path + " " + h.title).toLowerCase()).join(" ");
    expect(joined).toMatch(/mev|auction/);
  });

  it("finds limit-order docs", async () => {
    const hits = await searchDocs("limit order surplus fee");
    expect(hits.some((h) => h.path.includes("limit") || h.title.toLowerCase().includes("limit"))).toBe(true);
  });

  it("docs_page fetches by exact path, tolerant of slashes/extensions", async () => {
    const page = await getDocPage("cow-protocol/reference/core/signing_schemes");
    expect(page).not.toBeNull();
    expect(page!.text).toContain("Gnosis Protocol");
    // The corpus itself confirms the shared settlement contract — the
    // constant lib/order.ts hardcodes.
    expect(page!.text).toContain("0x9008D19f58AAbD9eD0D60971565AA8510560ab41");

    expect(await getDocPage("/cow-protocol/reference/core/signing_schemes.mdx")).not.toBeNull();
    expect(await getDocPage("no/such/page")).toBeNull();
  });

  it("empty/garbage queries return no hits, not errors", async () => {
    expect(await searchDocs("")).toEqual([]);
    expect(await searchDocs("zzzzqqqxxx notaword")).toEqual([]);
  });
});

describe("ranking (synthetic corpus)", () => {
  it("boosts title matches over body matches", async () => {
    setCorpusForTests([
      { path: "a", title: "Solvers", text: "generic text about things and stuff, plus a mention of ranking." },
      { path: "b", title: "Other", text: "solvers solvers solvers appear here in the body only." },
    ]);
    const hits = await searchDocs("solvers");
    expect(hits[0]!.path).toBe("a");
    setCorpusForTests(null); // restore lazy real corpus for other tests
  });
});
