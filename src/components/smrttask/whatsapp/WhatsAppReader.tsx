"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { ThreadList, type Thread } from "./ThreadList";
import { ThreadView, type Message, type ChatTask } from "./ThreadView";

interface WhatsAppReaderProps {
  /** Conversation to open on mount (null = show the chat list). */
  initialChatId?: string | null;
  /** One-shot draft to prefill the composer for the seeded chat. */
  initialDraft?: string | null;
  /** One-shot wamid to scroll-to + highlight when the seeded chat opens. */
  initialFocusWamid?: string | null;
  /**
   * "split"   = two-pane grid on md+ (list beside chat) — used by the full page.
   * "stacked" = single pane that toggles list ↔ chat at every width — used by
   *             the narrow docked side-panel.
   */
  layout?: "split" | "stacked";
  /** Reports the currently open conversation so a host (the panel) can build
   *  an "expand to full page" link. */
  onActiveChatChange?: (chatId: string | null) => void;
  className?: string;
}

/**
 * Shared WhatsApp reader: thread list + selected conversation, with the
 * threads/messages polling, read-receipts, and rename plumbing. Rendered
 * full-screen by WhatsAppPageClient and inside the docked WhatsAppPanel.
 */
export function WhatsAppReader({
  initialChatId = null,
  initialDraft = null,
  initialFocusWamid = null,
  layout = "split",
  onActiveChatChange,
  className,
}: WhatsAppReaderProps) {
  const { locale } = useParams();
  const t = useTranslations("whatsappPage");

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);

  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search across contact names (client-side over the loaded thread list) and
  // message content (server-side over the full message history). The content
  // search returns chat_id → newest matching snippet, which we surface as the
  // preview line so the user sees *why* a chat matched.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());

  // Collapse the search bar and reset the query so the full thread list comes
  // back. Used by the close button and the Escape key.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // Surface the active conversation to the host (used for the panel's
  // "expand to full page" link). Fires on mount and every selection change.
  useEffect(() => {
    onActiveChatChange?.(selectedChatId);
  }, [selectedChatId, onActiveChatChange]);

  const loadThreads = useCallback(async (opts: { background?: boolean } = {}) => {
    try {
      const { threads: list } = await api<{ threads: Thread[] }>("/api/whatsapp/threads");
      setThreads(list);
      setError(null);
    } catch (e) {
      // A failed background poll keeps the last good list on screen rather
      // than blanking it with a red banner over a transient blip — the
      // api() client already retried the request a few times.
      if (!opts.background) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  // Signatures of the last messages/tasks payloads we committed to state.
  // The conversation re-polls every 10s; replacing the arrays on every poll
  // forces every bubble to re-render and re-runs the (sizable) memos in
  // ThreadView even when nothing changed. Comparing a cheap signature first
  // lets an unchanged poll be a true no-op — the visible win the user feels
  // as "faster". Reset on chat switch so the new chat always paints.
  const messagesSigRef = useRef("");
  const tasksSigRef = useRef("");

  const loadMessages = useCallback(
    async (chatId: string, opts: { background?: boolean } = {}) => {
      // Background polls must never flash the header spinner or block the UI —
      // only an explicit load (chat switch / send) shows the loading state.
      if (!opts.background) setLoadingMessages(true);
      try {
        const { messages: m, tasks: tk } = await api<{ messages: Message[]; tasks: ChatTask[] }>(
          `/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}`,
        );
        const sig = m
          .map((x) => `${x.id}:${x.status ?? ""}:${x.reaction_emoji ?? ""}:${x.body_text ?? ""}:${x.media_url ?? ""}`)
          .join("|");
        if (sig !== messagesSigRef.current) {
          messagesSigRef.current = sig;
          setMessages(m);
        }
        const tlist = tk ?? [];
        const tsig = tlist.map((x) => `${x.id}:${x.status ?? ""}:${x.manually_verified}`).join("|");
        if (tsig !== tasksSigRef.current) {
          tasksSigRef.current = tsig;
          setTasks(tlist);
        }
        setError(null);
      } catch (e) {
        // Same as loadThreads: don't surface a transient background-poll
        // failure — keep the messages already on screen. Explicit loads
        // (chat open / after send) still report the error.
        if (!opts.background) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!opts.background) setLoadingMessages(false);
      }
    },
    [],
  );

  // Optimistically zero the unread badge, ACK the read to the server, then
  // refetch so the green pill clears within one round-trip (not the next poll).
  const markChatRead = useCallback(
    async (chatId: string) => {
      setThreads((curr) =>
        curr.map((th) => (th.chat_id === chatId ? { ...th, unread_count: 0 } : th)),
      );
      try {
        await api(`/api/whatsapp/threads/${encodeURIComponent(chatId)}/read`, { method: "POST" });
        loadThreads();
      } catch {
        /* best-effort — next poll reconciles */
      }
    },
    [loadThreads],
  );

  // Polling pauses while the tab is hidden (no point hitting the API for a
  // surface nobody's looking at) and refetches the instant it's foregrounded
  // again — so coming back to the tab shows fresh messages immediately rather
  // than after waiting out the next interval.
  useEffect(() => {
    loadThreads();
    const i = setInterval(() => {
      if (!document.hidden) loadThreads({ background: true });
    }, 30_000);
    const onVisible = () => {
      if (!document.hidden) loadThreads({ background: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadThreads]);

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([]);
      setTasks([]);
      return;
    }
    // New conversation → invalidate the dedup signatures so it always paints.
    messagesSigRef.current = "";
    tasksSigRef.current = "";
    loadMessages(selectedChatId);
    markChatRead(selectedChatId);
    const i = setInterval(() => {
      if (!document.hidden) loadMessages(selectedChatId, { background: true });
    }, 10_000);
    const onVisible = () => {
      if (!document.hidden) loadMessages(selectedChatId, { background: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedChatId, loadMessages, markChatRead]);

  // Debounced server-side search over message content. Names are filtered
  // locally (below) so they respond instantly; only the content query needs a
  // round-trip. A query under 2 chars clears results without hitting the API.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentMatches(new Map());
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const { results } = await api<{ results: { chat_id: string; snippet: string }[] }>(
          `/api/whatsapp/search?q=${encodeURIComponent(q)}`,
        );
        if (cancelled) return;
        setContentMatches(new Map(results.map((r) => [r.chat_id, r.snippet])));
      } catch {
        if (!cancelled) setContentMatches(new Map());
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  // Threads to render in the list. With no active query this is the full list;
  // with a query it's the union of name matches (instant, local) and content
  // matches (from the server), with the matched message shown as the preview.
  const displayThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads
      .filter((th) => {
        const name = (th.custom_name?.trim() || th.from_name?.trim() || th.from_phone || th.chat_id)
          .toLowerCase();
        const nameMatch = name.includes(q) || (th.from_phone ?? "").toLowerCase().includes(q);
        return nameMatch || contentMatches.has(th.chat_id);
      })
      .map((th) => {
        // For a content-only match, swap in the matched snippet so the row
        // explains itself (mirrors WhatsApp's in-chat search behaviour).
        const snippet = contentMatches.get(th.chat_id);
        return snippet ? { ...th, last_body_text: snippet } : th;
      });
  }, [threads, query, contentMatches]);

  // Visibility classes per layout. "split" keeps the mobile-stacked behaviour
  // but shows both panes side-by-side on md+. "stacked" toggles list ↔ chat at
  // every width (the narrow panel can't fit two panes).
  //
  // `grid-rows-1` (→ grid-template-rows: minmax(0,1fr)) is load-bearing: it
  // clamps the single row to the container's height instead of letting it grow
  // to the tallest column. Without it the thread-list column (which can hold far
  // more rows than fit) stretches the row past the viewport, the whole page
  // scrolls, and the chat pane's grey message area stretches to match — leaving
  // a long grey expanse below the conversation. With it, each pane is bounded to
  // the viewport and scrolls on its own (the list via its inner overflow, the
  // chat via its messages area), so the menu scrolls independently of the chat.
  const gridClass =
    layout === "split"
      ? "grid grid-rows-1 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] gap-3"
      : "grid grid-rows-1 grid-cols-1 gap-3";
  const listVisibility =
    layout === "split"
      ? `md:block ${selectedChatId ? "hidden" : "block"}`
      : selectedChatId
        ? "hidden"
        : "block";
  const chatVisibility =
    layout === "split"
      ? selectedChatId
        ? "block"
        : "hidden md:block"
      : selectedChatId
        ? "block"
        : "hidden";

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      {error && (
        <div className="mb-2 rounded border bg-status-late-bg p-2 text-sm text-status-late">
          {error}
        </div>
      )}

      <div className={`flex-1 min-h-0 ${gridClass}`}>
        <div className={`flex flex-col min-h-0 min-w-0 gap-2 ${listVisibility}`}>
          {searchOpen ? (
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-2.5 h-4 w-4 text-muted-foreground" />
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
                className="w-full rounded-lg border bg-card py-2 ps-9 pe-8 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={closeSearch}
                aria-label={t("searchClose")}
                title={t("searchClose")}
                className="absolute top-1/2 -translate-y-1/2 end-2 rounded p-0.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 justify-end">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label={t("searchOpen")}
                title={t("searchOpen")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <Search className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ThreadList
              threads={displayThreads}
              loading={loadingThreads}
              selectedChatId={selectedChatId}
              onSelect={setSelectedChatId}
              emptyLabel={query.trim() ? t("searchNoResults") : t("noThreads")}
            />
          </div>
        </div>

        <div className={`min-h-0 min-w-0 ${chatVisibility}`}>
          {selectedChatId ? (
            <ThreadView
              messages={messages}
              tasks={tasks}
              loading={loadingMessages}
              onBack={() => setSelectedChatId(null)}
              // The docked panel is single-pane at every width, so the
              // back-to-list button must always show (on the full page's
              // split layout the list is already visible beside the chat).
              alwaysShowBack={layout === "stacked"}
              chatId={selectedChatId}
              thread={threads.find((th) => th.chat_id === selectedChatId)}
              locale={locale as string}
              // Only the originally-seeded chat gets the prefilled draft —
              // switching to another conversation must start empty.
              initialDraft={selectedChatId === initialChatId ? initialDraft : null}
              // Same one-shot rule for the "jump to this message" anchor.
              focusWamid={selectedChatId === initialChatId ? initialFocusWamid : null}
              onContactRenamed={loadThreads}
              onMessageSent={() => {
                if (selectedChatId) {
                  loadMessages(selectedChatId);
                  markChatRead(selectedChatId);
                } else {
                  loadThreads();
                }
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border bg-muted/30 text-sm text-muted-foreground">
              {t("selectAThread")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
