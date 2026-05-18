export const dynamic = "force-dynamic";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listAllUserEmails } from "@/lib/supabase/admin";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";

export default async function AdminAppServicesPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const t = await getTranslations("admin");
  const supabase = await createClient();

  // Verify the slug exists in the apps registry so unregistered apps 404.
  const { data: app } = await supabase
    .from("apps")
    .select("id, name")
    .eq("slug", slug)
    .maybeSingle<{ id: string; name: string }>();
  if (!app) notFound();

  const [syncResult, usersResult, emailLookup] = await Promise.all([
    supabase.from("sync_state").select("*").order("last_synced_at", { ascending: false }),
    supabase.from("user_settings").select("user_id, display_name"),
    listAllUserEmails(),
  ]);

  const syncStates = syncResult.data || [];
  const nameMap = new Map((usersResult.data || []).map((u) => [u.user_id, u.display_name]));
  const emailMap = emailLookup.emails;

  const services = ["gmail", "google_drive", "google_calendar", "whatsapp"];

  const serviceLabels: Record<string, string> = {
    gmail: t("serviceGmail"),
    google_drive: t("serviceGoogleDrive"),
    google_calendar: t("serviceGoogleCalendar"),
    whatsapp: t("serviceWhatsapp"),
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {app.name}
        </Link>
        <h1 className="text-2xl font-bold">{t("serviceStatus")}</h1>
      </div>

      {services.map((service) => {
        const states = syncStates.filter((s) => s.source === service);

        return (
          <Card key={service}>
            <CardHeader>
              <CardTitle>{serviceLabels[service] ?? service}</CardTitle>
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
