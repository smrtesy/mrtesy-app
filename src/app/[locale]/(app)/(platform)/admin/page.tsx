export const dynamic = "force-dynamic";

import { readdirSync } from "fs";
import { join } from "path";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Users, Building2, Layers, Crown, FileText, DollarSign, BookOpen,
} from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1000;

type AdminClient = NonNullable<ReturnType<typeof createAdminSupabaseClient>>;

async function countRows(
  admin: AdminClient,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build?: (q: any) => any,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = admin.from(table).select("*", { count: "exact", head: true });
  if (build) q = build(q);
  const { count } = await q;
  return count ?? 0;
}

export default async function AdminDashboard({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");
  const nav = await getTranslations("adminNav");
  const admin = createAdminSupabaseClient();

  const since24h = new Date(Date.now() - DAY_MS).toISOString();

  let totalUsers = 0, activeUsers = 0, orgs = 0, apps = 0, superAdmins = 0;
  let errors24h = 0, aiCost24h = 0;

  if (admin) {
    const [
      uTotal, uActive, oCount, aCount, saCount, errCount, costRows,
    ] = await Promise.all([
      countRows(admin, "user_settings"),
      countRows(admin, "user_settings", (q) => q.eq("onboarding_completed", true)),
      countRows(admin, "organizations"),
      countRows(admin, "apps"),
      countRows(admin, "super_admins"),
      countRows(admin, "log_entries", (q) => q.eq("level", "error").gte("created_at", since24h)),
      admin.from("ai_usage").select("cost_usd").gte("created_at", since24h).limit(100000),
    ]);
    totalUsers = uTotal;
    activeUsers = uActive;
    orgs = oCount;
    apps = aCount;
    superAdmins = saCount;
    errors24h = errCount;
    aiCost24h = (costRows.data ?? []).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  }

  let docs = 0;
  try {
    docs = readdirSync(join(process.cwd(), "docs")).filter((f) => f.endsWith(".md")).length;
  } catch { /* docs dir may be absent in some builds */ }

  // Ordered to match the admin tab strip (AdminNav).
  const cards: Array<{
    href: string;
    label: string;
    icon: React.ReactNode;
    value: string;
    problem?: boolean;
    subtitle?: string;
    window?: string;
  }> = [
    {
      href: "users", label: nav("users"), icon: <Users className="h-4 w-4" />,
      value: String(totalUsers), subtitle: `${activeUsers} ${t("active")}`,
    },
    {
      href: "orgs", label: nav("orgs"), icon: <Building2 className="h-4 w-4" />,
      value: String(orgs),
    },
    {
      href: "apps", label: nav("apps"), icon: <Layers className="h-4 w-4" />,
      value: String(apps),
    },
    {
      href: "super-admins", label: nav("superAdmins"), icon: <Crown className="h-4 w-4" />,
      value: String(superAdmins),
    },
    {
      href: "logs", label: nav("logs"), icon: <FileText className="h-4 w-4" />,
      value: String(errors24h), problem: errors24h > 0, window: t("window24h"),
    },
    {
      href: "usage", label: nav("usage"), icon: <DollarSign className="h-4 w-4" />,
      value: `$${aiCost24h.toFixed(2)}`, window: t("window24h"),
    },
    {
      href: "docs", label: nav("docs"), icon: <BookOpen className="h-4 w-4" />,
      value: String(docs),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground -mt-4">{t("overviewSubtitle")}</p>

      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.href} href={`/${locale}/admin/${c.href}`} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/60 group-hover:bg-accent/30">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  {c.icon}
                  {c.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${c.problem ? "text-red-500" : ""}`}>
                  {c.value}
                </div>
                {c.subtitle && (
                  <p className={`text-xs ${c.problem ? "text-red-500" : "text-muted-foreground"}`}>
                    {c.subtitle}
                  </p>
                )}
                {c.window && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{c.window}</p>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
