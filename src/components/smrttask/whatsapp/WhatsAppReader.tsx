"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { ThreadList, type Thread } from "./ThreadList";
import { ThreadView, type Message, type ChatTask } from "./ThreadView";

// Mirrors the server's default page size for GET /whatsapp/messages
// (server/src/modules/smrttask/routes/whatsapp-view.ts, `limit` default 200).
// When an incremental poll comes back with a FULL page, the window was capped:
// more than this many rows changed since the cursor, the server kept only the
// 200 newest by received_at, and the older changed rows would never reach us
// (the cursor advances past them). In that case we discard the merge and
// refetch the conversation in full instead.
const WHATSAPP_MESSAGES_PAGE_LIMIT = 200;

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
  //
  // On top of that, background polls are INCREMENTAL: we pass
  // `after=<max updated_at seen>` so the server returns only rows that
  // changed since the last poll (usually zero) instead of re-shipping the
  // whole conversation with bodies/transcripts/OCR every 10s. Returned rows
  // are merged into state by wamid (update-or-append); the signature check
  // stays as the final "did anything actually change" gate for both paths.
  const messagesSigRef = useRef("");
  const tasksSigRef = useRef("");
  // Newest updated_at across the rows committed to state — the incremental
  // cursor. null = no full fetch landed yet (or the server predates the
  // updated_at column), in which case background polls stay full fetches.
  const messagesCursorRef = useRef<string | null>(null);
  // Mirror of the committed messages array, so the merge can run against the
  // current rows without threading state through the poll callback.
  const messagesRef = useRef<Message[]>([]);
  // Currently-selected chat, readable from inside async closures. A background
  // poll for chat A that resolves AFTER the user switched to chat B must be
  // dropped on the floor — merging A's rows into B's state corrupts both the
  // visible conversation and the incremental cursor, and incremental polls
  // never self-heal from that. Every await in loadMessages re-checks this ref.
  const selectedChatIdRef = useRef<string | null>(initialChatId);

  const loadMessages = useCallback(
    async (chatId: string, opts: { background?: boolean } = {}) => {
      // Background polls must never flash the header spinner or block the UI —
      // only an explicit load (chat switch / send) shows the loading state.
      if (!opts.background) setLoadingMessages(true);
      try {
        // Incremental only on background polls: explicit loads (chat switch /
        // after send) always refetch in full so the window stays authoritative.
        // The cursor is pulled back 10s to absorb clock skew / out-of-order
        // commits around the poll boundary — the wamid merge is idempotent,
        // so re-received rows are harmless.
        let cursor = opts.background ? messagesCursorRef.current : null;
        const afterParam = cursor
          ? `&after=${encodeURIComponent(new Date(new Date(cursor).getTime() - 10_000).toISOString())}`
          : "";
        let { messages: m, tasks: tk } = await api<{ messages: Message[]; tasks: ChatTask[] }>(
          `/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}${afterParam}`,
        );
        // Stale-response guard: the user switched chats while this request was
        // in flight — these rows belong to another conversation now.
        if (selectedChatIdRef.current !== chatId) return;
        if (cursor && m.length >= WHATSAPP_MESSAGES_PAGE_LIMIT) {
          // The incremental window overflowed the server's page cap: only the
          // 200 newest changed rows came back, and the older changed rows
          // would be silently skipped forever (bulk upserts stamp identical
          // updated_at values, so no later poll re-surfaces them). Discard the
          // merge and refetch the whole conversation, resetting the cursor
          // from the full result exactly like a chat-open load does.
          messagesCursorRef.current = null;
          ({ messages: m, tasks: tk } = await api<{ messages: Message[]; tasks: ChatTask[] }>(
            `/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}`,
          ));
          if (selectedChatIdRef.current !== chatId) return;
          cursor = null;
        }
        // Per-row change signature. updated_at is included so mutations the
        // other fields can't see (late transcript/OCR fills) still repaint.
        const rowSig = (x: Message) =>
          `${x.id}:${x.status ?? ""}:${x.reaction_emoji ?? ""}:${x.body_text ?? ""}:${x.media_url ?? ""}:${x.updated_at ?? ""}`;
        let next: Message[];
        if (cursor) {
          // Merge by wamid: replace changed rows, append new ones, keep the
          // object identity of untouched rows (ThreadView's memoized bubbles
          // skip re-rendering them), then restore chronological order.
          const byWamid = new Map(messagesRef.current.map((x) => [x.wamid, x]));
          let changed = false;
          for (const row of m) {
            const prev = byWamid.get(row.wamid);
            if (!prev || rowSig(prev) !== rowSig(row)) {
              byWamid.set(row.wamid, row);
              changed = true;
            }
          }
          next = changed
            ? [...byWamid.values()].sort(
                (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime(),
              )
            : messagesRef.current;
        } else {
          next = m;
        }
        const sig = next.map(rowSig).join("|");
        if (sig !== messagesSigRef.current) {
          messagesSigRef.current = sig;
          messagesRef.current = next;
          setMessages(next);
        }
        // Advance the cursor past everything we've now seen. ISO-8601 strings
        // from the same column compare correctly as strings.
        for (const row of next) {
          if (row.updated_at && (!messagesCursorRef.current || row.updated_at > messagesCursorRef.current)) {
            messagesCursorRef.current = row.updated_at;
          }
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
        // (chat open / after send) still report the error — but never for a
        // chat the user has already navigated away from.
        if (selectedChatIdRef.current !== chatId) return;
        if (!opts.background) setError(e instanceof Error ? e.message : String(e));
      } finally {
        // The stale-chat case leaves the spinner alone: the switch already
        // kicked off its own explicit load, which owns the loading state now.
        if (!opts.background && selectedChatIdRef.current === chatId) setLoadingMessages(false);
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
    // Keep the async-closure guard in sync BEFORE any load fires, so in-flight
    // responses for the previous chat are rejected from this point on.
    selectedChatIdRef.current = selectedChatId;
    if (!selectedChatId) {
      setMessages([]);
      setTasks([]);
      return;
    }
    // New conversation → invalidate the dedup signatures so it always paints,
    // and drop the incremental cursor/mirror so the first load is a full fetch.
    messagesSigRef.current = "";
    tasksSigRef.current = "";
    messagesCursorRef.current = null;
    messagesRef.current = [];
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
