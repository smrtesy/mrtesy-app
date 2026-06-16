"use client";

import { useEffect, useState, useCallback } from "react";
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

  const loadThreads = useCallback(async () => {
    try {
      const { threads: list } = await api<{ threads: Thread[] }>("/api/whatsapp/threads");
      setThreads(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    setLoadingMessages(true);
    try {
      const { messages: m, tasks: tk } = await api<{ messages: Message[]; tasks: ChatTask[] }>(
        `/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}`,
      );
      setMessages(m);
      setTasks(tk ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMessages(false);
    }
  }, []);

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

  useEffect(() => {
    loadThreads();
    const i = setInterval(loadThreads, 30_000);
    return () => clearInterval(i);
  }, [loadThreads]);

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([]);
      setTasks([]);
      return;
    }
    loadMessages(selectedChatId);
    markChatRead(selectedChatId);
    const i = setInterval(() => loadMessages(selectedChatId), 10_000);
    return () => clearInterval(i);
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
