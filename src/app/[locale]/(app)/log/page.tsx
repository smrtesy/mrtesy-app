export const dynamic = "force-dynamic";
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

const statusIcons: Record<string, string> = {
  ok: "✅",
  skipped: "⚠️",
  failed: "🔴",
  duplicate: "🔄",
};

export default async function LogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("log");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const adminEmails = (process.env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = adminEmails.includes(user.email?.toLowerCase() || "");

  const { data: logs } = await supabase
    .from("log_entries")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const dateFormatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      {(!logs || logs.length === 0) ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>{t("noEntries")}</p>
          <p className="text-xs mt-1">{t("entriesAppearAfter")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="rounded-lg border bg-card p-3 text-sm">
              {/* Row 1: source icon + status + category + time */}
              <div className="flex items-center gap-2">
                <span className="text-base">
                  {sourceIcons[log.source_type || ""] || "📋"}
                </span>
                <span className="text-xs">{statusIcons[log.status] || ""}</span>
                <Badge
                  variant={
                    log.status === "failed" ? "destructive" :
                    log.status === "skipped" ? "secondary" : "outline"
                  }
                  className="text-[10px]"
                >
                  {log.category}
                </Badge>
                {log.ai_classification && (
                  <Badge variant="outline" className="text-[10px]">{log.ai_classification}</Badge>
                )}
                <span className="ms-auto text-[10px] text-muted-foreground whitespace-nowrap">
                  {dateFormatter.format(new Date(log.created_at))}
                </span>
              </div>

              {/* Row 2: subject + sender */}
              {(log.subject || log.sender) && (
                <div className="mt-1.5">
                  {log.subject && (
                    <p className="text-xs font-medium truncate">
                      {log.source_url ? (
                        <a
                          href={log.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline hover:text-primary"
                        >
                          {log.subject}
                        </a>
                      ) : (
                        log.subject
                      )}
                    </p>
                  )}
                  {log.sender && (
                    <p className="text-[11px] text-muted-foreground truncate">
                      {log.sender}
                      {log.sender_email && log.sender_email !== log.sender && (
                        <span className="opacity-60"> ({log.sender_email})</span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {/* Row 3: classification reason / explanation */}
              {log.classification_reason && (
                <p className="mt-1.5 text-[11px] text-muted-foreground/80 line-clamp-2">
                  {log.classification_reason}
                </p>
              )}

              {/* Row 4: task created */}
              {log.task_title && (
                <div className="mt-1.5 flex items-center gap-1 text-[11px] text-primary">
                  <span>→</span>
                  <span className="truncate">{log.task_title}</span>
                </div>
              )}

              {/* Row 5: error */}
              {log.error_message && (
                <p className="mt-1.5 text-[11px] text-red-500 line-clamp-2">{log.error_message}</p>
              )}

              {/* Row 6: admin-only cost info */}
              {isAdmin && (log.ai_cost_usd || log.ai_model_used) && (
                <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/60">
                  {log.ai_model_used && <span>{log.ai_model_used}</span>}
                  {log.ai_input_tokens && <span>{log.ai_input_tokens}+{log.ai_output_tokens} tok</span>}
                  {log.ai_cost_usd && <span>${Number(log.ai_cost_usd).toFixed(5)}</span>}
                  {log.processing_duration_ms && <span>{log.processing_duration_ms}ms</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
