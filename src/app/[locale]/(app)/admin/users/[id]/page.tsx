export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UserMembershipsClient } from "@/components/admin/UserMembershipsClient";

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const supabase = await createClient();

  const [settingsResult, syncResult, logsResult, tasksResult] = await Promise.all([
    supabase.from("user_settings").select("*").eq("user_id", id).single(),
    supabase.from("sync_state").select("*").eq("user_id", id),
    supabase.from("log_entries").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(50),
    supabase.from("tasks").select("id, status", { count: "exact" }).eq("user_id", id),
  ]);

  const settings = settingsResult.data;
  const syncStates = syncResult.data || [];
  const logs = logsResult.data || [];
  const taskCount = tasksResult.count || 0;

  // Resolve email from auth.users (service-role required).
  let email = "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authUser } = await admin.auth.admin.getUserById(id);
    email = authUser?.user?.email || "";
  }

  if (!settings) {
    return <p>User not found</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold truncate">{email || settings.display_name || "User"}</h1>
        <p className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
          {settings.display_name && email && <span>{settings.display_name}</span>}
          {settings.display_name && email && <span>·</span>}
          <code className="font-mono text-[11px] opacity-70">{id}</code>
        </p>
      </div>

      {/* Memberships + effective app access (new) */}
      <UserMembershipsClient userId={id} locale={locale} />

      {/* Connections */}
      <Card>
        <CardHeader><CardTitle>Connections</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {["gmail", "drive", "whatsapp", "calendar"].map((service) => (
            <div key={service} className="flex items-center justify-between">
              <span className="capitalize">{service}</span>
              <Badge variant={settings[`${service}_connected` as keyof typeof settings] ? "default" : "destructive"}>
                {settings[`${service}_connected` as keyof typeof settings] ? "Connected" : "Disconnected"}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Sync State */}
      <Card>
        <CardHeader><CardTitle>Sync State</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {syncStates.map((s) => (
            <div key={s.id} className="rounded border p-2 text-sm">
              <div className="flex justify-between">
                <span className="font-medium capitalize">{s.source}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(s.last_synced_at).toLocaleString()}
                </span>
              </div>
              {s.consecutive_failures > 0 && (
                <p className="text-xs text-red-500">Failures: {s.consecutive_failures}</p>
              )}
              {s.last_error && (
                <p className="text-xs text-red-500 truncate">{s.last_error}</p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Stats */}
      <Card>
        <CardHeader><CardTitle>Stats</CardTitle></CardHeader>
        <CardContent>
          <p>Total tasks: {taskCount}</p>
          <p>Plan: {settings.plan}</p>
          <p>Language: {settings.preferred_language}</p>
          <p>Joined: {new Date(settings.created_at).toLocaleDateString()}</p>
        </CardContent>
      </Card>

      {/* Recent Logs */}
      <Card>
        <CardHeader><CardTitle>Recent Logs ({logs.length})</CardTitle></CardHeader>
        <CardContent className="max-h-96 overflow-y-auto space-y-1">
          {logs.slice(0, 20).map((log) => (
            <div key={log.id} className="flex gap-2 text-xs border-b py-1">
              <Badge variant={log.level === "error" ? "destructive" : "outline"} className="text-[10px]">
                {log.level}
              </Badge>
              <span className="text-muted-foreground">{log.category}</span>
              <span className="flex-1 truncate">{log.error_message || log.subject || log.task_title || "-"}</span>
              <span className="text-muted-foreground whitespace-nowrap">
                {new Date(log.created_at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
