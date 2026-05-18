export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Sparkles, ArrowLeft } from "lucide-react";
import { AppStatusCard } from "@/components/admin/AppStatusCard";

interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export default async function AdminAppDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const t = await getTranslations("admin");
  const supabase = await createClient();

  const { data: app } = await supabase
    .from("apps")
    .select("id, slug, name, description")
    .eq("slug", slug)
    .maybeSingle<AppRow>();

  if (!app) notFound();

  const { count: orgCount } = await supabase
    .from("app_memberships")
    .select("id", { count: "exact", head: true })
    .eq("app_id", app.id);

  const base = `/${locale}/admin/apps/${slug}`;

  const sections = [
    {
      key: "services",
      title: t("appServicesTitle"),
      description: t("appServicesDesc"),
      icon: Activity,
      href: `${base}/services`,
    },
    {
      key: "prompts",
      title: t("appPromptsTitle"),
      description: t("appPromptsDesc"),
      icon: Sparkles,
      href: `${base}/prompts`,
    },
  ];

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
