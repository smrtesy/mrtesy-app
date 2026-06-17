"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
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

  // Visibility classes per layout. "split" keeps the mobile-stacked behaviour
  // but shows both panes side-by-side on md+. "stacked" toggles list ↔ chat at
  // every width (the narrow panel can't fit two panes).
  const gridClass =
    layout === "split"
      ? "grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] gap-3"
      : "grid grid-cols-1 gap-3";
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
        <div className={`min-h-0 min-w-0 ${listVisibility}`}>
          <ThreadList
            threads={threads}
            loading={loadingThreads}
            selectedChatId={selectedChatId}
            onSelect={setSelectedChatId}
            emptyLabel={t("noThreads")}
          />
        </div>

        <div className={`min-h-0 min-w-0 ${chatVisibility}`}>
          {selectedChatId ? (
            <ThreadView
              messages={messages}
              tasks={tasks}
              loading={loadingMessages}
              onBack={() => setSelectedChatId(null)}
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
