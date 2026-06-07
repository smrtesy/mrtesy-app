"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { WebConversations } from "@/components/smrtbot/WebConversations";

interface LogRow {
  phone: string | null;
  direction: string | null;
  env: string | null;
  message_type: string | null;
  body: string | null;
  is_error: boolean;
  created_at: string;
}

export function LogsClient({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [mode, setMode] = useState<"messages" | "web">("messages");
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<"" | "IN" | "OUT">("");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const load = useCallback(async () => {
    if (mode !== "messages") return;
    setLogs(null);
    try {
      const qs = new URLSearchParams();
      if (dir) qs.set("direction", dir);
      if (errorsOnly) qs.set("errors", "true");
      const { logs } = await api<{ logs: LogRow[] }>(`/api/bot/${botId}/stats/logs?${qs.toString()}`);
      setLogs(logs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId, dir, errorsOnly, mode]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-3">
      {/* Channel switch: WhatsApp/system message log vs web-widget conversations. */}
      <div className="inline-flex rounded-md border border-border p-0.5">
        {([["messages", t("logsModeMessages")], ["web", t("logsModeWeb")]] as const).map(([v, lbl]) => (
          <button
            key={v}
            onClick={() => setMode(v as "messages" | "web")}
            className={"rounded px-3 py-1 text-sm " + (mode === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {lbl}
          </button>
        ))}
      </div>

      {mode === "web" ? (
        <WebConversations botId={botId} />
      ) : (
      <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {([["", t("logsAll")], ["IN", t("logsIn")], ["OUT", t("logsOut")]] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setDir(v as "" | "IN" | "OUT")}
              className={"rounded px-3 py-1 text-sm " + (dir === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              {lbl}
            </button>
          ))}
        </div>
        <Button variant={errorsOnly ? "default" : "outline"} size="sm" onClick={() => setErrorsOnly((v) => !v)}>
          {t("logsErrorsOnly")}
        </Button>
      </div>

      {logs === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">{t("noItems")}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("logsTime")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("f_phone")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("logsDir")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("f_type")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("f_body")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i} className={"border-t border-border " + (l.is_error ? "bg-status-late-bg" : "")}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2" dir="ltr">{l.phone}</td>
                  <td className="px-3 py-2">{l.direction}</td>
                  <td className="px-3 py-2">{l.message_type}</td>
                  <td className="max-w-[24rem] truncate px-3 py-2" dir="auto">{l.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </div>
  );
}
