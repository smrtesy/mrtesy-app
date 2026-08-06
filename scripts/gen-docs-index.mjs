// Generates src/generated/docs-index.json — the full index the bilingual docs
// tab reads (docs/bilingual-docs-plan.md). One entry per docs/**/*.md file:
//
//   { path, docKey, lang, mixed, title, content, sourceHash, created, updated }
//
// Why baked (not read at runtime): the tab renders on Vercel, where a shallow
// clone means git history is gone and arbitrary docs/*.md files are NOT traced
// into the serverless bundle — a runtime readFileSync(process.cwd()/docs) can
// return nothing. Baking the content + git timestamps here, committed, makes
// the tab work identically everywhere and gives us language/title/docKey once.
//
// Re-run after adding or editing docs:  node scripts/gen-docs-index.mjs
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const outDir = join(root, "src", "generated");
const out = join(outDir, "docs-index.json");

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root }).toString().trim();
  } catch {
    return "";
  }
};

/** Every .md under docs/, recursively, as repo-relative paths ("docs/sub/x.md"). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Parse a leading `--- ... ---` YAML-ish frontmatter block into a flat map. */
function frontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

/**
 * Detect the dominant language from the prose, and whether the doc is heavily
 * bilingual (both languages present in force → a candidate for splitting).
 * Code fences, inline code and URLs are stripped first so a Hebrew doc full of
 * English identifiers still reads as Hebrew.
 */
function detectLanguage(content) {
  const prose = content
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/^---\n[\s\S]*?\n---\n/, " "); // frontmatter
  const hebrew = (prose.match(/[֐-׿]/g) || []).length;
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  const total = hebrew + latin;
  if (total === 0) return { lang: "en", mixed: false };
  const hebShare = hebrew / total;
  const lang = hebShare >= 0.5 ? "he" : "en";
  // "Mixed" = the minority language carries a real share of a doc that is big
  // enough for a split to make sense (not just a few stray words).
  const minorityShare = Math.min(hebShare, 1 - hebShare);
  const mixed = minorityShare >= 0.2 && total >= 400;
  return { lang, mixed };
}

/** Human title: frontmatter override → first `# H1` → filename. */
function extractTitle(content, fm, lang, basename) {
  const override = lang === "he" ? fm.title_he : fm.title_en;
  if (override || fm.title) return override || fm.title;
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].replace(/[#*`]/g, "").trim();
  return basename.replace(/\.md$/, "");
}

/** docKey = repo-relative path minus docs/ prefix, .md, and any .he/.en suffix. */
function toDocKey(relPath) {
  return relPath
    .replace(/^docs\//, "")
    .replace(/\.md$/, "")
    .replace(/\.(he|en)$/, "");
}

/** Language suffix in the filename, if the convention is used (foo.he.md). */
function suffixLang(relPath) {
  const m = relPath.match(/\.(he|en)\.md$/);
  return m ? m[1] : null;
}

const docs = [];
for (const full of walk(docsDir).sort()) {
  const relPath = relative(root, full).replace(/\\/g, "/"); // docs/sub/x.md
  const basename = relPath.split("/").pop();
  const content = readFileSync(full, "utf-8");
  const fm = frontmatter(content);

  const detected = detectLanguage(content);
  // An explicit filename suffix or frontmatter `lang:` beats the heuristic.
  const lang = suffixLang(relPath) || fm.lang || detected.lang;

  const created =
    (git(`log --diff-filter=A --follow --format=%aI -- "${relPath}"`).split("\n").pop() || null);
  const updated = git(`log -1 --format=%aI -- "${relPath}"`) || null;

  docs.push({
    path: relPath,
    docKey: toDocKey(relPath),
    lang,
    mixed: detected.mixed,
    title: extractTitle(content, fm, lang, basename),
    content,
    sourceHash: createHash("sha256").update(content).digest("hex").slice(0, 12),
    created,
    updated,
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify({ docs }, null, 2) + "\n");
const mixed = docs.filter((d) => d.mixed).length;
console.log(`[gen-docs-index] wrote ${out} (${docs.length} docs, ${mixed} flagged mixed)`);
