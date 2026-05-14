export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AdminServicesPage() {
  const t = await getTranslations("admin");
  const supabase = await createClient();

  // Parallel queries — no broken join
  const [syncResult, usersResult] = await Promise.all([
    supabase.from("sync_state").select("*").order("last_synced_at", { ascending: false }),
    supabase.from("user_settings").select("user_id, display_name"),
  ]);

  const syncStates = syncResult.data || [];
  const nameMap = new Map((usersResult.data || []).map((u) => [u.user_id, u.display_name]));

  // Emails live in auth.users — only the service-role client can read them.
  const emailMap = new Map<string, string>();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData } = await admin.auth.admin.listUsers({ perPage: 100 });
    for (const u of authData?.users || []) {
      if (u.email) emailMap.set(u.id, u.email);
    }
  }

  const services = ["gmail", "google_drive", "google_calendar", "whatsapp"];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("serviceStatus")}</h1>

      {services.map((service) => {
        const states = syncStates.filter((s) => s.source === service);

        return (
          <Card key={service}>
            <CardHeader>
              <CardTitle className="capitalize">{service.replace(/_/g, " ")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {states.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("noUsersConnected")}</p>
              )}
              {states.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded border p-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {emailMap.get(s.user_id) || nameMap.get(s.user_id) || "—"}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <code className="font-mono text-[10px] opacity-60">{s.user_id.slice(0, 8)}</code>
                      <span>·</span>
                      <span className="truncate">
                        {t("lastSuccess")}: {s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : t("noUsersConnected")}
                      </span>
                    </p>
                  </div>
                  <div className="text-end">
                    {(s.consecutive_failures || 0) === 0 ? (
                      <Badge variant="default" className="bg-green-500">OK</Badge>
                    ) : (s.consecutive_failures || 0) >= 5 ? (
                      <Badge variant="destructive">FAILED ({s.consecutive_failures})</Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-yellow-500 text-white">
                        WARN ({s.consecutive_failures})
                      </Badge>
                    )}
                    {s.last_error && (
                      <p className="text-xs text-red-500 mt-1 max-w-[200px] truncate">{s.last_error}</p>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
