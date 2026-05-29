export const dynamic = "force-dynamic";

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { DocsBrowser } from "@/components/admin/DocsBrowser";
import docsMeta from "@/generated/docs-meta.json";

type DocMeta = { created: string | null; updated: string | null };

/**
 * Per-app spec/docs surface. Renders the markdown files committed under
 * `docs/apps/<slug>/` — the convention for an app's design/spec docs that
 * live in the repo. Empty until the app's first doc is added there.
 */
export default async function AdminAppDocumentsPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const t = await getTranslations("admin");

  // Reject anything that isn't a clean slug before touching the filesystem.
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) notFound();

  const admin = createAdminSupabaseClient();
  if (!admin) notFound();
  const { data: app } = await admin
    .from("apps")
    .select("name")
    .eq("slug", slug)
    .maybeSingle<{ name: string }>();
  if (!app) notFound();

  const dir = join(process.cwd(), "docs", "apps", slug);
  const meta = docsMeta as Record<string, DocMeta>;
  let docs: { filename: string; content: string; created: string | null; updated: string | null }[] = [];
  try {
    docs = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((filename) => {
        const key = `apps/${slug}/${filename}`;
        return {
          filename,
          content: readFileSync(join(dir, filename), "utf-8"),
          created: meta[key]?.created ?? null,
          updated: meta[key]?.updated ?? null,
        };
      });
  } catch {
    /* folder may not exist yet for this app */
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {app.name}
        </Link>
        <h1 className="text-2xl font-bold">{t("appDocumentsTitle")}</h1>
        <p className="text-xs text-muted-foreground">
          {t("appDocumentsPageHint", { path: `docs/apps/${slug}/` })}
        </p>
      </div>

      <DocsBrowser
        docs={docs}
        pathPrefix={`docs/apps/${slug}/`}
        emptyMessage={t("appDocumentsEmpty", { path: `docs/apps/${slug}/` })}
      />
    </div>
  );
}
