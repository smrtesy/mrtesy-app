"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";

interface Session {
  id: string;
  lead_name: string | null;
  lead_email: string;
  lead_phone: string | null;
  origin: string | null;
  last_seen_at: string;
  created_at: string;
}

interface WebMessage {
  id: string;
  direction: "in" | "out";
  kind: "text" | "buttons" | "image" | "list";
  body: string;
  payload: {
    buttons?: { id: string; title: string }[];
    rows?: { id: string; title: string; description?: string }[];
    url?: string;
    caption?: string;
  };
  created_at: string;
}

/** Read-only browser for the lead sessions captured by the web widget. */
export function WebConversations({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<WebMessage[] | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions } = await api<{ sessions: Session[] }>(`/api/bot/${botId}/web/sessions`);
      setSessions(sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const openSession = useCallback(
    async (id: string) => {
      setSelected(id);
      setMessages(null);
      try {
        const { messages } = await api<{ messages: WebMessage[] }>(
          `/api/bot/${botId}/web/sessions/${id}/messages`,
        );
        setMessages(messages);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    },
    [botId],
  );

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (sessions === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
        {t("convEmpty")}
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-[18rem_1fr]">
      {/* Sessions list */}
      <div className="max-h-[32rem] space-y-1 overflow-y-auto rounded-lg border border-border p-1">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => openSession(s.id)}
            className={
              "w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted " +
              (selected === s.id ? "bg-accent text-accent-foreground" : "")
            }
          >
            <div className="font-medium">{s.lead_name || t("convAnon")}</div>
            <div className="truncate text-xs text-muted-foreground" dir="ltr">{s.lead_email}</div>
            <div className="text-[11px] text-muted-foreground">{new Date(s.last_seen_at).toLocaleString()}</div>
          </button>
        ))}
      </div>

      {/* Thread */}
      <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border p-3">
        {selected === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("convSelect")}</p>
        ) : messages === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <div key={m.id} className={"flex " + (m.direction === "in" ? "justify-end" : "justify-start")}>
                <div
                  className={
                    "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm " +
                    (m.direction === "in"
                      ? "rounded-br-sm bg-primary text-primary-foreground"
                      : "rounded-bl-sm bg-muted text-foreground")
                  }
                  dir="auto"
                >
                  {m.kind === "image" && m.payload.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.payload.url} alt={m.payload.caption ?? ""} className="max-w-full rounded-lg" />
                  ) : (
                    m.body
                  )}
                  {m.kind === "buttons" && m.payload.buttons && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.payload.buttons.map((b) => (
                        <span key={b.id} className="rounded-full border border-border px-2 py-0.5 text-xs opacity-80">
                          {b.title}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.kind === "list" && m.payload.rows && (
                    <div className="mt-1 flex flex-col gap-1">
                      {m.payload.rows.map((r) => (
                        <span key={r.id} className="rounded-md border border-border px-2 py-0.5 text-xs opacity-80">
                          {r.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
