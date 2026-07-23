"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MessageSquare, ArrowRight, ArrowLeft, RefreshCw, CheckSquare, Search, X } from "lucide-react";

/** Normalized key for matching phone numbers stored in inconsistent formats —
 *  mirrors the server's normPhone (digits; last 10 when it's a real number). */
function normPhoneKey(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 10 ? d.slice(-10) : d;
}

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

  // Collapsed-by-default search over the conversation list: phone/number is
  // filtered locally (instant), message content is searched server-side. The
  // content search returns peer → newest matching snippet, keyed on the
  // normalized number so it lines up with exactly one thread row.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

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

  // Debounced server-side search over message content. Numbers/preview are
  // filtered locally (below) so they respond instantly; only the content query
  // needs a round-trip. A query under 2 chars clears results without hitting
  // the API.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentMatches(new Map());
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const { results } = await api<{ results: { peer: string; snippet: string }[] }>(
          `/api/sms/search?q=${encodeURIComponent(q)}`,
        );
        if (cancelled) return;
        setContentMatches(new Map(results.map((r) => [normPhoneKey(r.peer), r.snippet])));
      } catch {
        if (!cancelled) setContentMatches(new Map());
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  // Threads to render. No query → the full list. With a query → the union of
  // number/preview matches (instant, local) and content matches (server), with
  // the matched message swapped in as the preview so the row explains itself.
  const displayThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    const qDigits = q.replace(/\D/g, "");
    return threads
      .filter((th) => {
        const peer = th.peer.toLowerCase();
        const numberMatch =
          peer.includes(q) ||
          (qDigits.length > 0 && normPhoneKey(th.peer).includes(qDigits));
        const previewMatch = (th.last_body_text ?? "").toLowerCase().includes(q);
        return numberMatch || previewMatch || contentMatches.has(normPhoneKey(th.peer));
      })
      .map((th) => {
        const snippet = contentMatches.get(normPhoneKey(th.peer));
        return snippet ? { ...th, last_body_text: snippet } : th;
      });
  }, [threads, query, contentMatches]);

  const BackIcon = locale === "he" ? ArrowRight : ArrowLeft;

  const list = (
    <div className={cn("flex flex-col min-h-0 border rounded-lg overflow-hidden", selected && "hidden @2xl:flex")}>
      {searchOpen ? (
        <div className="relative border-b bg-muted/30 p-2">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-4 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="w-full rounded-md border bg-card py-1.5 ps-9 pe-8 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={closeSearch}
            aria-label={t("searchClose")}
            title={t("searchClose")}
            className="absolute top-1/2 -translate-y-1/2 end-4 rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/30">
          <span className="text-sm font-semibold">{t("conversations")}</span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setSearchOpen(true)}
              aria-label={t("searchOpen")}
              title={t("searchOpen")}
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => loadThreads()} aria-label={t("refresh")}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {threadsLoading ? (
          <div className="p-3 space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
          </div>
        ) : displayThreads.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {query.trim() ? t("searchNoResults") : t("empty")}
          </div>
        ) : (
          <ul>
            {displayThreads.map((th) => (
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
