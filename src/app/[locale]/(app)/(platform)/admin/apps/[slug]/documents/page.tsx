export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { DocsBrowser } from "@/components/admin/DocsBrowser";

interface AppPlanRow {
  id: string;
  title: string;
  content: string;
  doc_type: string;
  version: number;
  is_current: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Per-app documents surface. Renders the plan / spec documents stored for the
 * app in the `app_plans` table (markdown content authored while shaping the
 * app — architecture, spec, idea, notes). Most-current first.
 */
export default async function AdminAppDocumentsPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const t = await getTranslations("admin");

  // /admin is super-admin-gated by the layout; read with the service-role
  // client so app_plans rows are visible regardless of org-scoped RLS.
  const admin = createAdminSupabaseClient();
  if (!admin) notFound();

  const { data: app } = await admin
    .from("apps")
    .select("name")
    .eq("slug", slug)
    .maybeSingle<{ name: string }>();
  if (!app) notFound();

  const { data: plans } = await admin
    .from("app_plans")
    .select("id, title, content, doc_type, version, is_current, created_at, updated_at")
    .eq("app_slug", slug)
    .order("is_current", { ascending: false })
    .order("version", { ascending: false })
    .order("updated_at", { ascending: false })
    .returns<AppPlanRow[]>();

  const docs = (plans ?? []).map((p) => ({
    // Title carries the doc type + version so the nav reads at a glance.
    filename: `${p.title} · ${p.doc_type} v${p.version}`,
    content: p.content,
    created: p.created_at,
    updated: p.updated_at,
  }));

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
        <p className="text-xs text-muted-foreground">{t("appDocumentsPageHint")}</p>
      </div>

      <DocsBrowser docs={docs} pathPrefix="" emptyMessage={t("appDocumentsEmpty")} />
    </div>
  );
}
