// Generates src/generated/docs-meta.json — git created/updated timestamps for
// each docs/*.md file. Committed so the docs tab can show real authoring dates
// even on Vercel (shallow clone / no git at runtime). Re-run after adding or
// editing docs:  node scripts/gen-docs-meta.mjs
import { execSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const outDir = join(root, "src", "generated");
const out = join(outDir, "docs-meta.json");

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root }).toString().trim();
  } catch {
    return "";
  }
};

const meta = {};
for (const f of readdirSync(docsDir).filter((x) => x.endsWith(".md")).sort()) {
  const createdLog = git(`log --diff-filter=A --follow --format=%aI -- "docs/${f}"`);
  const created = createdLog ? createdLog.split("\n").pop() : null;
  const updated = git(`log -1 --format=%aI -- "docs/${f}"`) || null;
  meta[f] = { created: created || null, updated };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
console.log(`[gen-docs-meta] wrote ${out} (${Object.keys(meta).length} docs)`);
