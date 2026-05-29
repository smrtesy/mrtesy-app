// Generates src/generated/docs-meta.json — git created/updated timestamps for
// each docs/*.md file. Committed so the docs tab can show real authoring dates
// even on Vercel (shallow clone / no git at runtime). Re-run after adding or
// editing docs:  node scripts/gen-docs-meta.mjs
import { execSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
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

// Walk docs/ recursively so per-app docs (docs/apps/<slug>/*.md) are captured
// too. Keys are the path relative to docs/ — top-level docs keep their bare
// filename ("new-app-guide.md"), so the platform docs tab keeps working;
// nested docs key by their sub-path ("apps/smrtvoice/overview.md").
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

const meta = {};
for (const full of walk(docsDir).sort()) {
  const rel = relative(docsDir, full).split("\\").join("/");
  const createdLog = git(`log --diff-filter=A --follow --format=%aI -- "docs/${rel}"`);
  const created = createdLog ? createdLog.split("\n").pop() : null;
  const updated = git(`log -1 --format=%aI -- "docs/${rel}"`) || null;
  meta[rel] = { created: created || null, updated };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
console.log(`[gen-docs-meta] wrote ${out} (${Object.keys(meta).length} docs)`);
