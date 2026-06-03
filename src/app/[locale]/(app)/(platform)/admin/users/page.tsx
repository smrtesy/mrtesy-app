export const dynamic = "force-dynamic";
import { listAllUserEmails, createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

export default async function AdminUsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");
  const tWarn = await getTranslations("adminUsers");

  // The /admin section is already super-admin-gated by the layout, so we read
  // platform-wide data with the service-role client. The RLS-scoped client
  // would only ever return the admin's own user_settings/org_members row,
  // which is why the list previously showed just one user.
  const admin = createAdminSupabaseClient();
  const emailLookup = await listAllUserEmails();

  if (!admin) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t("users")}</h1>
        <div className="rounded-md border border-status-warn bg-status-warn-bg p-3 text-xs text-status-warn">
          {tWarn("serviceRoleMissing")}
        </div>
      </div>
    );
  }

  const [{ data: users }, { data: memberships }] = await Promise.all([
    admin
      .from("user_settings")
      .select("user_id, display_name, onboarding_completed, created_at")
      .order("created_at", { ascending: false }),
    admin
      .from("org_members")
      .select("user_id, organizations(id, name, name_he)"),
  ]);

  const emailMap = Object.fromEntries(emailLookup.emails.entries());

  // user_id → first org name
  const isHe = locale === "he";
  const orgMap: Record<string, string> = {};
  for (const m of memberships ?? []) {
    if (!orgMap[m.user_id] && m.organizations) {
      const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
      if (org) orgMap[m.user_id] = (isHe && (org as { name_he?: string | null }).name_he) ? (org as { name_he: string }).name_he : (org as { name: string }).name;
    }
  }

  // user_id → enabled app names via org memberships
  const { data: appMemberships } = await admin
    .from("org_members")
    .select("user_id, org_id");

  const orgIds = [...new Set((appMemberships ?? []).map((m) => m.org_id))];
  const appsByOrg: Record<string, string[]> = {};
  if (orgIds.length > 0) {
    const { data: enabledApps } = await admin
      .from("app_memberships")
      .select("org_id, apps(name, slug)")
      .in("org_id", orgIds);

    for (const a of enabledApps ?? []) {
      if (!appsByOrg[a.org_id]) appsByOrg[a.org_id] = [];
      const appData = (Array.isArray(a.apps) ? a.apps[0] : a.apps) as { name?: string; slug?: string } | null;
      const name = appData?.name || appData?.slug || "";
      if (name && !appsByOrg[a.org_id].includes(name)) appsByOrg[a.org_id].push(name);
    }
  }

  const userApps: Record<string, string[]> = {};
  for (const m of appMemberships ?? []) {
    if (!userApps[m.user_id]) userApps[m.user_id] = [];
    for (const app of appsByOrg[m.org_id] ?? []) {
      if (!userApps[m.user_id].includes(app)) userApps[m.user_id].push(app);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("users")}</h1>

      {emailLookup.error === "service_role_missing" && (
        <div className="rounded-md border border-status-warn bg-status-warn-bg p-3 text-xs text-status-warn">
          {tWarn("serviceRoleMissing")}
        </div>
      )}

      <div className="space-y-2">
        {(users || []).map((user) => (
          <Link
            key={user.user_id}
            href={`/${locale}/admin/users/${user.user_id}`}
            className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent"
          >
            <div className="min-w-0">
              <p className="font-medium truncate">
                {emailMap[user.user_id] || user.display_name || "—"}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                {orgMap[user.user_id] ? (
                  <span dir="auto">{orgMap[user.user_id]}</span>
                ) : (
                  <span className="italic opacity-60">—</span>
                )}
                <span>·</span>
                <code className="font-mono text-[10px] opacity-60">{user.user_id.slice(0, 8)}</code>
              </p>
            </div>
            <div className="flex gap-1 flex-wrap justify-end">
              {(userApps[user.user_id] ?? []).map((name) => (
                <Badge key={name} variant="outline" className="text-xs">{name}</Badge>
              ))}
              {!user.onboarding_completed && (
                <Badge variant="secondary" className="text-xs">Onboarding</Badge>
              )}
            </div>
          </Link>
        ))}
        {(!users || users.length === 0) && (
          <p className="text-center text-muted-foreground py-8">{t("noUsers")}</p>
        )}
      </div>
    </div>
  );
}
