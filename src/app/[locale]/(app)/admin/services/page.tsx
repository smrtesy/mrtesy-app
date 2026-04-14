import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AdminServicesPage() {
  const supabase = createClient();

  const { data: syncStates } = await supabase
    .from("sync_state")
    .select("*")
    .order("last_synced_at", { ascending: false });

  const services = ["gmail", "google_drive", "google_calendar", "whatsapp"];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Service Status</h1>

      {services.map((service) => {
        const states = (syncStates || []).filter((s) => s.source === service);

        return (
          <Card key={service}>
            <CardHeader>
              <CardTitle className="capitalize">{service.replace("_", " ")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {states.length === 0 && (
                <p className="text-sm text-muted-foreground">No users connected</p>
              )}
              {states.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded border p-2">
                  <div>
                    <p className="text-sm font-medium">
                      {s.user_id.slice(0, 8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last sync: {new Date(s.last_synced_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-end">
                    {s.consecutive_failures === 0 ? (
                      <Badge variant="default" className="bg-green-500">OK</Badge>
                    ) : s.consecutive_failures >= 5 ? (
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
