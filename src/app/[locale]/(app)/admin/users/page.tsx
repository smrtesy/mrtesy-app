export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
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
  const supabase = await createClient();

  const { data: users } = await supabase
    .from("user_settings")
    .select("user_id, plan, display_name, gmail_connected, drive_connected, whatsapp_connected, calendar_connected, onboarding_completed, created_at")
    .order("created_at", { ascending: false });

  // Fetch emails from auth.users via admin API
  const emailMap: Record<string, string> = {};
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData } = await admin.auth.admin.listUsers({ perPage: 100 });
    for (const u of authData?.users || []) {
      emailMap[u.id] = u.email || "";
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("users")}</h1>

      <div className="space-y-2">
        {(users || []).map((user) => (
          <Link
            key={user.user_id}
            href={`/${locale}/admin/users/${user.user_id}`}
            className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent"
          >
            <div>
              <p className="font-medium">{user.display_name || emailMap[user.user_id] || user.user_id.slice(0, 8)}</p>
              <p className="text-xs text-muted-foreground">{emailMap[user.user_id] ? `${user.plan || "free"} · ${emailMap[user.user_id]}` : user.plan}</p>
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
