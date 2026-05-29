export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Sparkles, BookOpen, ArrowLeft, KeyRound, SlidersHorizontal, FileText } from "lucide-react";
import { AppStatusCard } from "@/components/admin/AppStatusCard";
import { getAdminSections, type AdminSectionKey } from "@/lib/apps/registry";

interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  guide_url: string | null;
}

export default async function AdminAppDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const t = await getTranslations("admin");
  // /admin is super-admin-gated by the layout; read with the service-role
  // client so the org count isn't scoped to the admin's own memberships (RLS).
  const admin = createAdminSupabaseClient();
  if (!admin) notFound();

  const { data: app } = await admin
    .from("apps")
    .select("id, slug, name, description, guide_url")
    .eq("slug", slug)
    .maybeSingle<AppRow>();

  if (!app) notFound();

  const { count: orgCount } = await admin
    .from("app_memberships")
    .select("id", { count: "exact", head: true })
    .eq("app_id", app.id);

  const base = `/${locale}/admin/apps/${slug}`;

  // Each app declares its own card set (see lib/apps/registry). This keeps
  // smrtTask-only surfaces (service sync, WhatsApp secrets, system params)
  // off apps they don't apply to.
  const SECTION_DEFS: Record<
    AdminSectionKey,
    { titleKey: string; descKey: string; icon: typeof Activity; path: string }
  > = {
    services:   { titleKey: "appServicesTitle",   descKey: "appServicesDesc",   icon: Activity,         path: "services" },
    prompts:    { titleKey: "appPromptsTitle",    descKey: "appPromptsDesc",    icon: Sparkles,         path: "prompts" },
    secrets:    { titleKey: "appSecretsTitle",    descKey: "appSecretsDesc",    icon: KeyRound,         path: "secrets" },
    parameters: { titleKey: "appParametersTitle", descKey: "appParametersDesc", icon: SlidersHorizontal, path: "parameters" },
    documents:  { titleKey: "appDocumentsTitle",  descKey: "appDocumentsDesc",  icon: FileText,         path: "documents" },
  };

  interface SectionCard {
    key: string;
    title: string;
    description: string;
    icon: typeof Activity;
    href: string;
  }

  const sections: SectionCard[] = getAdminSections(slug).map((key) => {
    const def = SECTION_DEFS[key];
    return {
      key,
      title: t(def.titleKey),
      description: t(def.descKey),
      icon: def.icon,
      href: `${base}/${def.path}`,
    };
  });

  if (app.guide_url) {
    sections.push({
      key: "guide",
      title: t("appGuideTitle"),
      description: t("appGuideDesc"),
      icon: BookOpen,
      href: `/${locale}${app.guide_url}`,
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {t("allApps")}
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{app.name}</h1>
          <Badge variant="outline" className="font-mono text-[10px]">{app.slug}</Badge>
          <Badge variant="secondary" className="text-[10px]">
            {t("orgsCount", { count: orgCount ?? 0 })}
          </Badge>
        </div>
        {app.description && (
          <p className="text-sm text-muted-foreground">{app.description}</p>
        )}
      </div>

      <AppStatusCard slug={slug} />

      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.key} href={s.href}>
              <Card className="hover:bg-accent/40 transition-colors h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-base">{s.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-xs">{s.description}</CardDescription>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
