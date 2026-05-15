export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { listAllUserEmails } from "@/lib/supabase/admin";
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
  const supabase = await createClient();

  const [{ data: users }, emailLookup] = await Promise.all([
    supabase
      .from("user_settings")
      .select("user_id, plan, display_name, gmail_connected, drive_connected, whatsapp_connected, calendar_connected, onboarding_completed, created_at")
      .order("created_at", { ascending: false }),
    listAllUserEmails(),
  ]);
  const emailMap = Object.fromEntries(emailLookup.emails.entries());

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("users")}</h1>

      {emailLookup.error === "service_role_missing" && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900">
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
                <span>{user.plan || "free"}</span>
                {user.display_name && emailMap[user.user_id] && (
                  <>
                    <span>·</span>
                    <span className="truncate">{user.display_name}</span>
                  </>
                )}
                <span>·</span>
                <code className="font-mono text-[10px] opacity-60">{user.user_id.slice(0, 8)}</code>
              </p>
            </div>
            <div className="flex gap-1">
              {user.gmail_connected && <Badge variant="outline" className="text-xs">Gmail</Badge>}
              {user.drive_connected && <Badge variant="outline" className="text-xs">Drive</Badge>}
              {user.whatsapp_connected && <Badge variant="outline" className="text-xs">WA</Badge>}
              {user.calendar_connected && <Badge variant="outline" className="text-xs">Cal</Badge>}
              {!user.onboarding_completed && <Badge variant="secondary" className="text-xs">Onboarding</Badge>}
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
