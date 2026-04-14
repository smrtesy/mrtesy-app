import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";

const sourceIcons: Record<string, string> = {
  gmail: "📧",
  whatsapp: "💬",
  google_drive: "📁",
  google_calendar: "📅",
};

export default async function LogPage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  const t = await getTranslations("log");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const { data: logs } = await supabase
    .from("log_entries")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      {(!logs || logs.length === 0) ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>{t("noEntries")}</p>
          <p className="text-xs mt-1">{t("entriesAppearAfter")}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-2 rounded border p-3 text-sm">
              <span className="text-base mt-0.5">
                {sourceIcons[log.source_type || ""] || "📋"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant={
                      log.status === "failed" ? "destructive" :
                      log.status === "skipped" ? "secondary" : "outline"
                    }
                    className="text-[10px]"
                  >
                    {log.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{log.category}</span>
                  {log.ai_classification && (
                    <Badge variant="outline" className="text-[10px]">{log.ai_classification}</Badge>
                  )}
                </div>
                {log.subject && (
                  <p className="text-xs mt-1 truncate">{log.subject}</p>
                )}
                {log.sender && (
                  <p className="text-xs text-muted-foreground truncate">{log.sender}</p>
                )}
                {log.error_message && (
                  <p className="text-xs text-red-500 mt-1 truncate">{log.error_message}</p>
                )}
              </div>
              <div className="text-end shrink-0">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(log.created_at).toLocaleTimeString()}
                </span>
                {log.ai_cost_usd && (
                  <p className="text-[10px] text-muted-foreground">${Number(log.ai_cost_usd).toFixed(5)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
