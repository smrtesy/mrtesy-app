export const dynamic = "force-dynamic";

import { BilingualDocsBrowser, type LogicalDoc, type LangSlot } from "@/components/admin/BilingualDocsBrowser";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import docsIndex from "@/generated/docs-index.json";

type Lang = "he" | "en";

interface IndexDoc {
  path: string;
  docKey: string;
  lang: string;
  mixed: boolean;
  title: string;
  content: string;
  sourceHash: string;
  created: string | null;
  updated: string | null;
}

interface TranslationRow {
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

/**
 * The docs tab, bilingual. Repo docs/**.md (baked into docs-index.json so they
 * render on Vercel too — no runtime fs) are the source of truth for their own
 * language; the other language is filled by an on-demand translation cached in
 * doc_translations. Two columns, one per language; an empty slot gets a
 * translate button. Design: docs/bilingual-docs-plan.md.
 */
export default async function AdminDocsPage() {
  const repoDocs = (docsIndex as { docs: IndexDoc[] }).docs;

  // /admin is super-admin-gated by the layout; read translations with the
  // service-role client (the table has no org scope — it's repo docs).
  const admin = createAdminSupabaseClient();
  let translations: TranslationRow[] = [];
  if (admin) {
    const { data, error } = await admin
      .from("doc_translations")
      .select("doc_key, source_path, target_lang, title, content, status, error, source_hash, updated_at")
      .returns<TranslationRow[]>();
    // Fall back to no translations on read failure, but don't hide it — a
    // silent [] would re-prompt the user to re-translate docs already cached.
    if (error) console.error("[admin/docs] failed to read doc_translations:", error.message);
    translations = data ?? [];
  }

  // Group everything by docKey.
  const byKey = new Map<string, { repo: Partial<Record<Lang, IndexDoc>>; mixed: boolean }>();
  for (const d of repoDocs) {
    const entry = byKey.get(d.docKey) ?? { repo: {}, mixed: false };
    if (d.lang === "he" || d.lang === "en") entry.repo[d.lang] = d;
    entry.mixed = entry.mixed || d.mixed;
    byKey.set(d.docKey, entry);
  }
  const trByKey = new Map<string, Partial<Record<Lang, TranslationRow>>>();
  for (const t of translations) {
    if (t.target_lang !== "he" && t.target_lang !== "en") continue;
    const entry = trByKey.get(t.doc_key) ?? {};
    entry[t.target_lang as Lang] = t;
    trByKey.set(t.doc_key, entry);
  }

  const docs: LogicalDoc[] = [];
  for (const [docKey, { repo, mixed }] of byKey) {
    const tr = trByKey.get(docKey) ?? {};
    // The repo file we translate FROM (the language that exists on disk).
    const sourceDoc = repo.he ?? repo.en;
    if (!sourceDoc) continue;

    const slotFor = (lang: Lang): LangSlot | null => {
      const r = repo[lang];
      if (r) {
        return {
          lang,
          title: r.title,
          content: r.content,
          source: "repo",
          status: "ready",
          sourcePath: r.path,
          sourceHash: r.sourceHash,
          created: r.created,
          updated: r.updated,
        };
      }
      const t = tr[lang];
      if (t) {
        // Stale if the source file changed since this translation was made.
        const currentSourceHash = sourceDoc.sourceHash;
        return {
          lang,
          title: t.title ?? sourceDoc.title,
          content: t.content,
          source: "translation",
          status: (t.status as LangSlot["status"]) ?? "ready",
          error: t.error,
          sourceHash: t.source_hash,
          staleSource: t.status === "ready" && !!t.source_hash && t.source_hash !== currentSourceHash,
          updated: t.updated_at,
          created: null,
        };
      }
      return null;
    };

    docs.push({
      docKey,
      mixed,
      slots: { he: slotFor("he"), en: slotFor("en") },
      source: {
        path: sourceDoc.path,
        lang: sourceDoc.lang as Lang,
        title: sourceDoc.title,
        content: sourceDoc.content,
        sourceHash: sourceDoc.sourceHash,
      },
    });
  }

  // Sort by the label that will show (Hebrew title if present, else English).
  docs.sort((a, b) => {
    const la = a.slots.he?.title ?? a.slots.en?.title ?? a.docKey;
    const lb = b.slots.he?.title ?? b.slots.en?.title ?? b.docKey;
    return la.localeCompare(lb, "he");
  });

  const missing = docs.filter((d) => !d.slots.he || !d.slots.en).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">מסמכים</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          תיעוד פנימי — {docs.length} מסמכים · {missing} ממתינים לתרגום · טור לכל שפה
        </p>
      </div>
      <BilingualDocsBrowser docs={docs} />
    </div>
  );
}
