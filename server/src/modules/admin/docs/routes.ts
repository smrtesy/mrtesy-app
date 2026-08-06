/**
 * Bilingual docs tab — on-demand translation of repo docs/**.md.
 * Design: docs/bilingual-docs-plan.md.
 *
 * The whole router is gated by requireAuth + requireSuperAdmin (mounted in
 * modules/admin/index.ts). Translation runs on the built-in Claude runner
 * (runOneShot → subscription, ZERO paid API tokens), stored in doc_translations
 * so the tab shows it instantly without a deploy.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";
import { runOneShot } from "../../claude/runner";

const router = Router();
// Path-scoped to "/admin" ON PURPOSE — a bare router.use() would gate every
// /api request that falls through here (see .claude/rules/server-routing.md).
router.use("/admin/docs", requireAuth, requireSuperAdmin);

const LANGS = new Set(["he", "en"]);
const LANG_NAME: Record<string, string> = { he: "עברית", en: "English (אנגלית)" };
// A single runOneShot prompt is one argv entry, capped by Linux MAX_ARG_STRLEN
// (~128 KB bytes; Hebrew ≈ 2 bytes/char). Keep the source content per call well
// under that after the wrapper — larger docs are split on H2 boundaries.
const MAX_CHUNK_CHARS = 40_000;

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

interface TranslationRow {
  id: string;
  doc_key: string;
  source_path: string;
  target_lang: string;
  title: string | null;
  content: string | null;
  status: string;
  error: string | null;
  source_hash: string | null;
  updated_at: string | null;
}

/** All cached translations — the client polls this for live status. */
router.get("/admin/docs/translations", async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from("doc_translations")
    .select("id, doc_key, source_path, target_lang, title, content, status, error, source_hash, updated_at")
    .returns<TranslationRow[]>();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ translations: data ?? [] });
});

/**
 * Kick off (or restart) a translation. Returns immediately with status:running;
 * the actual runOneShot work happens in the background and the row is updated
 * when it finishes. The client polls /translations until status:ready.
 */
router.post("/admin/docs/translate", async (req: Request, res: Response) => {
  const { doc_key, source_path, target_lang, source_content, source_title } = req.body ?? {};

  if (typeof doc_key !== "string" || !doc_key.trim()) {
    res.status(400).json({ error: "doc_key required" });
    return;
  }
  if (typeof source_path !== "string" || !source_path.trim()) {
    res.status(400).json({ error: "source_path required" });
    return;
  }
  if (typeof target_lang !== "string" || !LANGS.has(target_lang)) {
    res.status(400).json({ error: "target_lang must be he or en" });
    return;
  }
  if (typeof source_content !== "string" || !source_content.trim()) {
    res.status(400).json({ error: "source_content required" });
    return;
  }

  const sourceHash = shortHash(source_content);

  // Upsert the row to running (unique on doc_key+target_lang). A stuck/failed
  // row is simply restarted by clicking translate again.
  const { data: row, error: upsertErr } = await db
    .from("doc_translations")
    .upsert(
      {
        doc_key,
        source_path,
        target_lang,
        status: "running",
        error: null,
        source_hash: sourceHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "doc_key,target_lang" },
    )
    .select("id")
    .single<{ id: string }>();

  if (upsertErr || !row) {
    res.status(500).json({ error: upsertErr?.message ?? "failed to enqueue" });
    return;
  }

  // Fire-and-forget: the runner is long-lived on Railway, so the translation
  // completes after we've already answered the request. Errors land on the row.
  void runTranslation(row.id, {
    docKey: doc_key,
    targetLang: target_lang,
    sourceContent: source_content,
    sourceTitle: typeof source_title === "string" ? source_title : "",
  });

  res.json({ id: row.id, status: "running" });
});

/** Split markdown into chunks under MAX_CHUNK_CHARS, preferring H2 boundaries. */
function splitForTranslation(content: string): string[] {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  // Split at top-level "## " headings, keeping the heading with its section.
  const sections = content.split(/(?=^## )/m);
  const chunks: string[] = [];
  let cur = "";
  for (const section of sections) {
    if (cur && (cur.length + section.length) > MAX_CHUNK_CHARS) {
      chunks.push(cur);
      cur = "";
    }
    // A single section larger than the cap: hard-split on blank lines.
    if (section.length > MAX_CHUNK_CHARS) {
      if (cur) { chunks.push(cur); cur = ""; }
      const paras = section.split(/\n\n+/);
      let p = "";
      for (const para of paras) {
        if (p && (p.length + para.length + 2) > MAX_CHUNK_CHARS) { chunks.push(p); p = ""; }
        p += (p ? "\n\n" : "") + para;
      }
      if (p) chunks.push(p);
    } else {
      cur += section;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function buildPrompt(lang: string, chunk: string, isPart: boolean): string {
  const name = LANG_NAME[lang] ?? lang;
  return [
    `אתה מתרגם מסמך טכני. תרגם את מסמך ה-Markdown הבא לשפה: ${name}.`,
    `- שמור על מבנה ה-Markdown בדיוק: כותרות, רשימות, טבלאות, גושי-קוד.`,
    `- אל תתרגם קוד, שמות-קוד, נתיבים, מזהים, או תוכן בתוך גושי-קוד או inline code.`,
    `- שמור כל קישור (URL) בדיוק כלשונו — כולל פרמטרים, עוגנים ומזהים.`,
    isPart
      ? `- זהו חלק מתוך מסמך ארוך; תרגם אותו כפי שהוא בלי להוסיף כותרת-על.`
      : `- תרגם גם את כותרת ה-H1.`,
    `- החזר אך ורק את ה-Markdown המתורגם, בלי הקדמה, בלי סימוני "הנה התרגום", ובלי הערות.`,
    ``,
    chunk,
  ].join("\n");
}

/** Extract an H1 title from translated markdown; fall back to the source title. */
function titleFrom(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].replace(/[#*`]/g, "").trim() : fallback;
}

async function runTranslation(
  rowId: string,
  args: { docKey: string; targetLang: string; sourceContent: string; sourceTitle: string },
): Promise<void> {
  const fail = async (message: string) => {
    await db
      .from("doc_translations")
      .update({ status: "error", error: message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", rowId);
  };

  try {
    const chunks = splitForTranslation(args.sourceContent);
    const outParts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const out = await runOneShot(buildPrompt(args.targetLang, chunks[i], chunks.length > 1), {
        label: `doc-translate:${args.docKey}->${args.targetLang}${chunks.length > 1 ? `#${i + 1}/${chunks.length}` : ""}`,
        timeoutMs: 8 * 60_000,
        // A whole translated document, not a title — the default 8 KB cap would
        // silently truncate it. Each source chunk is <=40 KB chars; allow ample
        // room for the translation (and Hebrew's larger char count).
        maxChars: 300_000,
      });
      if (out == null || !out.trim()) {
        await fail("התרגום לא הצליח (הרצת קלוד לא החזירה תוצאה — ייתכן מגבלת-שימוש; נסה שוב).");
        return;
      }
      outParts.push(out.trim());
    }
    const content = outParts.join("\n\n");
    await db
      .from("doc_translations")
      .update({
        status: "ready",
        content,
        title: titleFrom(content, args.sourceTitle),
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
}

export default router;
