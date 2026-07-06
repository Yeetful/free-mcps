// Build the bundled CoW docs corpus → lib/docs-data.json.
//
// Downloads the official docs repo (github.com/cowprotocol/docs) as a
// tarball, extracts every .md/.mdx under docs/, strips frontmatter + JSX/
// import noise, and emits [{path, title, text}] for docs_search/docs_page.
//
// Run manually (network required): `pnpm build-docs` in services/cow.
// The generated lib/docs-data.json IS COMMITTED so the serverless deploy
// needs no network or build step — re-run this script + commit to refresh.

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TARBALL_URL = "https://codeload.github.com/cowprotocol/docs/tar.gz/refs/heads/main";
const MAX_PAGE_CHARS = 12_000;
const MAX_CORPUS_BYTES = 3_500_000;

interface DocPage {
  path: string;
  title: string;
  text: string;
}

function stripMarkdown(raw: string): { title: string | null; text: string } {
  let text = raw;

  // Frontmatter (--- ... ---) at the top; capture a title if present.
  let fmTitle: string | null = null;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const titleLine = fm[1]!.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleLine) fmTitle = titleLine[1]!;
    text = text.slice(fm[0].length);
  }

  text = text
    // import/export lines (MDX)
    .replace(/^(import|export)\s.*$/gm, "")
    // Docusaurus admonition markers
    .replace(/^:::\s*\w*.*$/gm, "")
    .replace(/^:::$/gm, "")
    // HTML/JSX tags (keep inner text)
    .replace(/<[^>\n]{1,200}>/g, " ")
    // markdown images
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // markdown links → keep the label
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // code fences: keep contents, drop the fence lines
    .replace(/^```[\w-]*$/gm, "")
    // collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  return { title: fmTitle ?? heading?.[1]?.trim() ?? null, text };
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "cowdocs-"));
  console.log(`Downloading ${TARBALL_URL} → ${work}`);
  execSync(`curl -sL ${TARBALL_URL} -o ${work}/docs.tar.gz && tar xzf ${work}/docs.tar.gz -C ${work} --strip-components=1`, {
    stdio: "inherit",
  });

  const files = execSync(`find ${work}/docs -type f \\( -name '*.md' -o -name '*.mdx' \\)`, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  console.log(`${files.length} markdown files found`);

  const pages: DocPage[] = [];
  const dropped: string[] = [];
  for (const file of files) {
    const rel = path.relative(`${work}/docs`, file).replace(/\.(md|mdx)$/, "");
    // Partials are include-fragments, not standalone pages.
    if (rel.includes("partials/") || path.basename(rel).startsWith("_")) {
      dropped.push(`${rel} (partial)`);
      continue;
    }
    const raw = readFileSync(file, "utf8");
    const { title, text } = stripMarkdown(raw);
    if (text.length < 80) {
      dropped.push(`${rel} (too short: ${text.length} chars)`);
      continue;
    }
    const clipped = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) + "\n\n[page truncated]" : text;
    if (text.length > MAX_PAGE_CHARS) console.log(`  truncated ${rel}: ${text.length} → ${MAX_PAGE_CHARS}`);
    pages.push({
      path: rel,
      title: title ?? rel.split("/").pop()!.replace(/[-_]/g, " "),
      text: clipped,
    });
  }

  // Corpus size cap: drop the biggest pages if we blow the budget.
  let json = JSON.stringify(pages);
  while (Buffer.byteLength(json) > MAX_CORPUS_BYTES && pages.length > 0) {
    const biggest = pages.reduce((a, b) => (a.text.length >= b.text.length ? a : b));
    pages.splice(pages.indexOf(biggest), 1);
    dropped.push(`${biggest.path} (corpus size cap)`);
    console.log(`  DROPPED for size cap: ${biggest.path} (${biggest.text.length} chars)`);
    json = JSON.stringify(pages);
  }

  const out = path.join(__dirname, "..", "lib", "docs-data.json");
  writeFileSync(out, json);
  console.log(
    `\nWrote ${out}: ${pages.length} pages, ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB` +
      `\nDropped ${dropped.length}: ${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", …" : ""}`,
  );
  rmSync(work, { recursive: true, force: true });
}

void main();
