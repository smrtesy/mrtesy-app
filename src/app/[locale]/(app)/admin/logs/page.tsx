import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";

export default async function AdminLogsPage() {
  const supabase = createClient();

  const { data: logs } = await supabase
    .from("log_entries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">System Logs</h1>

      <div className="space-y-1">
        {(logs || []).map((log) => (
          <div key={log.id} className="flex items-start gap-2 rounded border p-2 text-sm">
            <Badge
              variant={log.level === "error" ? "destructive" : log.level === "warning" ? "secondary" : "outline"}
              className="text-[10px] mt-0.5"
            >
              {log.level}
            </Badge>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{log.category}</span>
                <Badge variant="outline" className="text-[10px]">{log.status}</Badge>
              </div>
              {log.subject && <p className="text-xs text-muted-foreground truncate">{log.subject}</p>}
              {log.error_message && <p className="text-xs text-red-500 truncate">{log.error_message}</p>}
              {log.ai_cost_usd && <span className="text-xs text-muted-foreground">${Number(log.ai_cost_usd).toFixed(6)}</span>}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(log.created_at).toLocaleString()}
            </span>
          </div>
        ))}
        {(!logs || logs.length === 0) && (
          <p className="text-center text-muted-foreground py-8">No logs yet</p>
        )}
      </div>
    </div>
  );
}
