export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AdminDashboard() {
  const t = await getTranslations("admin");
  const supabase = await createClient();

  const [usersResult, deadLetterResult, errorsResult, aiCostResult] = await Promise.all([
    supabase.from("user_settings").select("user_id, onboarding_completed"),
    supabase.from("source_messages").select("id", { count: "exact" }).eq("dead_letter", true),
    supabase.from("log_entries").select("id, category, error_message, created_at").eq("level", "error").order("created_at", { ascending: false }).limit(10),
    supabase.from("log_entries").select("ai_cost_usd").gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()).not("ai_cost_usd", "is", null),
  ]);

  const users = usersResult.data || [];
  const deadLetters = deadLetterResult.count || 0;
  const recentErrors = errorsResult.data || [];
  const todayCost = (aiCostResult.data || []).reduce((sum, r) => sum + (Number(r.ai_cost_usd) || 0), 0);

  const alerts: Array<{ level: string; message: string }> = [];
  if (deadLetters > 10) {
    alerts.push({ level: "critical", message: t("alertDeadLetters", { count: deadLetters }) });
  }
  if (todayCost > 5) {
    alerts.push({ level: "important", message: t("alertAiCost", { cost: todayCost.toFixed(2) }) });
  }

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
    </div>
  );
}
