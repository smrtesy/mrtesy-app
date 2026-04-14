export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

export default async function AdminDashboard({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");
  const supabase = await createClient();

  const [usersResult, deadLetterResult, errorsResult, aiCostResult, syncResult] = await Promise.all([
    supabase.from("user_settings").select("user_id, onboarding_completed, gmail_connected, drive_connected, whatsapp_connected, calendar_connected"),
    supabase.from("source_messages").select("id", { count: "exact" }).eq("dead_letter", true),
    supabase.from("log_entries").select("id, category, error_message, created_at").eq("level", "error").order("created_at", { ascending: false }).limit(10),
    supabase.from("log_entries").select("ai_cost_usd").gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()).not("ai_cost_usd", "is", null),
    supabase.from("sync_state").select("user_id, source, last_synced_at, consecutive_failures, last_error").order("last_synced_at", { ascending: false }),
  ]);

  const users = usersResult.data || [];
  const deadLetters = deadLetterResult.count || 0;
  const recentErrors = errorsResult.data || [];
  const todayCost = (aiCostResult.data || []).reduce((sum, r) => sum + (Number(r.ai_cost_usd) || 0), 0);
  const syncStates = syncResult.data || [];

  const services = ["gmail", "google_drive", "google_calendar", "whatsapp"];

  function getServiceStatus(source: string) {
    const states = syncStates.filter((s) => s.source === source);
    const failed = states.filter((s) => (s.consecutive_failures || 0) >= 5);
    const warn = states.filter((s) => (s.consecutive_failures || 0) > 0 && (s.consecutive_failures || 0) < 5);
    if (failed.length > 0) return "error";
    if (warn.length > 0) return "warn";
    if (states.length === 0) return "none";
    return "ok";
  }

  function statusBadge(status: string) {
    switch (status) {
      case "ok": return <Badge variant="default" className="bg-green-500">OK</Badge>;
      case "warn": return <Badge variant="secondary" className="bg-yellow-500 text-white">WARN</Badge>;
      case "error": return <Badge variant="destructive">ERROR</Badge>;
      default: return <Badge variant="outline">N/A</Badge>;
    }
  }

  // Alerts
  const alerts: Array<{ level: string; message: string }> = [];
  if (syncStates.filter((s) => (s.consecutive_failures || 0) >= 5).length > 0) {
    alerts.push({ level: "critical", message: "Sync stopped for some users (consecutive failures >= 5)" });
  }
  if (deadLetters > 10) {
    alerts.push({ level: "critical", message: `${deadLetters} dead letter messages` });
  }
  if (todayCost > 5) {
    alerts.push({ level: "important", message: `AI cost today: $${todayCost.toFixed(2)}` });
  }

  const basePath = `/${locale}/admin`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div key={i} className={`rounded-lg border p-3 text-sm ${alert.level === "critical" ? "border-red-500 bg-red-50 text-red-700" : "border-yellow-500 bg-yellow-50 text-yellow-700"}`}>
              {alert.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("users")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
            <p className="text-xs text-muted-foreground">
              {users.filter((u) => u.onboarding_completed).length} {t("active")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("aiCostToday")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${todayCost.toFixed(4)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("deadLetters")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${deadLetters > 0 ? "text-red-500" : ""}`}>{deadLetters}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("errors24h")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${recentErrors.length > 0 ? "text-red-500" : ""}`}>{recentErrors.length}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("serviceStatus")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {services.map((service) => {
            const status = getServiceStatus(service);
            const lastSync = syncStates
              .filter((s) => s.source === service)
              .sort((a, b) => new Date(b.last_synced_at!).getTime() - new Date(a.last_synced_at!).getTime())[0];
            return (
              <div key={service} className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  {statusBadge(status)}
                  <span className="font-medium capitalize">{service.replace(/_/g, " ")}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {lastSync?.last_synced_at ? new Date(lastSync.last_synced_at).toLocaleString() : t("noUsersConnected")}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {recentErrors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("recentErrors")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentErrors.slice(0, 5).map((err) => (
              <div key={err.id} className="rounded border p-2 text-sm">
                <div className="flex justify-between">
                  <Badge variant="destructive" className="text-xs">{err.category}</Badge>
                  <span className="text-xs text-muted-foreground">{new Date(err.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground truncate">{err.error_message}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3">
        <Link href={`${basePath}/users`} className="rounded-lg border p-3 hover:bg-accent flex-1 text-center text-sm font-medium">{t("users")}</Link>
        <Link href={`${basePath}/services`} className="rounded-lg border p-3 hover:bg-accent flex-1 text-center text-sm font-medium">{t("services")}</Link>
        <Link href={`${basePath}/logs`} className="rounded-lg border p-3 hover:bg-accent flex-1 text-center text-sm font-medium">{t("logs")}</Link>
      </div>
    </div>
  );
}
