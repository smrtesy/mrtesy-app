"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MessageSquare, ArrowRight, ArrowLeft, RefreshCw, CheckSquare } from "lucide-react";

interface SmsThread {
  peer: string;
  last_message_at: string;
  last_direction: "incoming" | "outgoing";
  last_body_text: string | null;
  task_count?: number;
}

interface SmsMessage {
  id: string;
  message_id: string;
  direction: "incoming" | "outgoing";
  from_phone: string;
  to_phone: string | null;
  body_text: string | null;
  is_otp: boolean;
  received_at: string;
}

const THREADS_POLL_MS = 20000;

/**
 * Read-only SMS conversation reader. Two panes on desktop (list + conversation),
 * single pane on mobile. Data comes from the server's /api/sms/threads and
 * /api/sms/messages endpoints; there is no compose/send (deferred).
 */
export function SmsReader({
  initialPeer,
  seedKey,
  className,
}: {
  initialPeer?: string | null;
  seedKey?: string;
  className?: string;
}) {
  const t = useTranslations("smsPage");
  const { locale } = useParams() as { locale: string };

  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(initialPeer ?? null);

  // Deep-link into an already-mounted reader (pane dedupe updates the seed
  // prop in place instead of remounting) — apply it.
  useEffect(() => {
    if (initialPeer) setSelected(initialPeer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeer, seedKey]);

  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fmtTime = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  const loadThreads = useCallback(async () => {
    try {
      const r = await api<{ threads: SmsThread[] }>("/api/sms/threads");
      setThreads(r.threads ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) {
        // keep the current list on transient errors; surfacing a toast on a
        // background poll would be noisy
        console.warn("[sms] loadThreads:", (e as Error).message);
      }
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (peer: string) => {
    setMessagesLoading(true);
    try {
      const r = await api<{ messages: SmsMessage[] }>(
        `/api/sms/messages?peer=${encodeURIComponent(peer)}`,
      );
      setMessages(r.messages ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) console.warn("[sms] loadMessages:", (e as Error).message);
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  // Initial load + light polling so new incoming SMS surface without a refresh.
  useEffect(() => {
    loadThreads();
    const h = setInterval(loadThreads, THREADS_POLL_MS);
    return () => clearInterval(h);
  }, [loadThreads]);

  useEffect(() => {
    if (selected) loadMessages(selected);
    else setMessages([]);
  }, [selected, loadMessages]);

  // Scroll the conversation to the newest message when it changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const BackIcon = locale === "he" ? ArrowRight : ArrowLeft;

  const list = (
    <div className={cn("flex flex-col min-h-0 border rounded-lg overflow-hidden", selected && "hidden @2xl:flex")}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/30">
        <span className="text-sm font-semibold">{t("conversations")}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => loadThreads()} aria-label={t("refresh")}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {threadsLoading ? (
          <div className="p-3 space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
          </div>
        ) : threads.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          <ul>
            {threads.map((th) => (
              <li key={th.peer}>
                <button
                  type="button"
                  onClick={() => setSelected(th.peer)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b px-3 py-2 text-start transition-colors hover:bg-accent",
                    selected === th.peer && "bg-primary/10",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate" dir="auto">{th.peer}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {fmtTime.format(new Date(th.last_message_at))}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="flex-1 truncate text-xs text-muted-foreground" dir="auto">
                      {th.last_direction === "outgoing" ? "↖ " : ""}
                      {th.last_body_text || ""}
                    </span>
                    {(th.task_count ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[10px] text-primary">
                        <CheckSquare className="h-2.5 w-2.5" />{th.task_count}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const conversation = (
    <div className={cn("flex flex-col min-h-0 border rounded-lg overflow-hidden", !selected && "hidden @2xl:flex")}>
      {selected ? (
        <>
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 @2xl:hidden"
              onClick={() => setSelected(null)}
              aria-label={t("back")}
            >
              <BackIcon className="h-4 w-4" />
            </Button>
            <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-semibold truncate" dir="auto">{selected}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/10">
            {messagesLoading && messages.length === 0 ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-2/3 rounded-lg" />)}
              </div>
            ) : messages.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">{t("noMessages")}</div>
            ) : (
              messages.map((m) => {
                const out = m.direction === "outgoing";
                return (
                  <div key={m.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[80%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap break-words",
                        out ? "bg-primary text-primary-foreground" : "bg-background border",
                      )}
                      dir="auto"
                    >
                      {m.body_text}
                      <div className={cn("mt-0.5 text-[10px]", out ? "text-primary-foreground/70" : "text-muted-foreground")}>
                        {m.is_otp && <span className="me-1">🔒</span>}
                        {fmtTime.format(new Date(m.received_at))}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("selectConversation")}
        </div>
      )}
    </div>
  );

  return (
    <div className={cn("@container grid min-h-0 gap-2 @2xl:grid-cols-[320px_1fr]", className)}>
      {list}
      {conversation}
    </div>
  );
}
