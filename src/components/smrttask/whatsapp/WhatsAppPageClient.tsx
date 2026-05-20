"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { ThreadList, type Thread } from "./ThreadList";
import { ThreadView, type Message, type ChatTask } from "./ThreadView";

/**
 * Two-pane WhatsApp reader. Left: chat list. Right: messages in the
 * selected chat. On mobile, the right pane takes over the whole screen
 * once a chat is selected (controlled by `selectedChatId`).
 */
export function WhatsAppPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const searchParams = useSearchParams();
  const t = useTranslations("whatsappPage");
  const isHe = locale === "he";

  const initialChatId = searchParams.get("chat_id");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);

  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const { threads: t } = await api<{ threads: Thread[] }>("/api/whatsapp/threads");
      setThreads(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    setLoadingMessages(true);
    try {
      const { messages: m, tasks: t } = await api<{ messages: Message[]; tasks: ChatTask[] }>(
        `/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}`,
      );
      setMessages(m);
      setTasks(t ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  /** Tell the backend the user has opened this chat. The unread badge
   *  used to wait for the next 30s /threads poll to clear; now we
   *  optimistically zero it out in local state the instant the chat
   *  opens, AND trigger an immediate /threads refetch after the server
   *  ACKs the read. The result: the green pill disappears within one
   *  network round-trip, not at the next poll. */
  const markChatRead = useCallback(
    async (chatId: string) => {
      // Optimistic local clear — instant visual feedback.
      setThreads((curr) =>
        curr.map((th) => (th.chat_id === chatId ? { ...th, unread_count: 0 } : th)),
      );
      try {
        await api(`/api/whatsapp/threads/${encodeURIComponent(chatId)}/read`, {
          method: "POST",
        });
        // Cheap refresh so server-truth catches up with the local guess.
        loadThreads();
      } catch {
        // Best-effort — a stale unread badge is harmless. The next poll
        // will reconcile the local state with the server.
      }
    },
    [loadThreads],
  );

  useEffect(() => {
    loadThreads();
    // Refresh thread list every 30s so new chats appear without a reload.
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
    // Mark the chat as read so its unread badge clears on the next
    // /threads poll. Fire-and-forget — the read state is best-effort.
    markChatRead(selectedChatId);
    // Poll the open thread for new messages every 10s.
    const i = setInterval(() => loadMessages(selectedChatId), 10_000);
    return () => clearInterval(i);
  }, [selectedChatId, loadMessages, markChatRead]);

  return (
    // Full-screen chat surface — no title, no chat count, no top bar.
    // The two panes carry their own chrome (chat names on the left,
    // contact header inside the open thread on the right). 100dvh fills
    // the viewport even when the mobile address bar collapses. The
    // sidebar's own toggle button floats fixed in the top-start corner
    // (rendered from Sidebar.tsx), so we don't reserve any vertical
    // space for it here.
    //
    // -mx-4 -my-4 cancels the app shell's px-4 py-4 padding so the
    // chat hits the screen edges.
    <div
      className="-mx-4 -my-4 flex flex-col h-[calc(100dvh-3.5rem)] md:h-[100dvh]"
      dir={isHe ? "rtl" : "ltr"}
    >
      {/* Accessibility-only title — read by screen readers but invisible
          and takes no layout space. The chat panes themselves are the
          visible UI. */}
      <h1 className="sr-only">{title}</h1>

      {error && (
        <div className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-3">
        {/* Mobile: hide thread list when a chat is open */}
        <div
          className={`md:block min-h-0 ${selectedChatId ? "hidden" : "block"}`}
        >
          <ThreadList
            threads={threads}
            loading={loadingThreads}
            selectedChatId={selectedChatId}
            onSelect={setSelectedChatId}
            emptyLabel={t("noThreads")}
          />
        </div>

        {/* Mobile: hide message view when no chat is selected */}
        <div className={`min-h-0 ${selectedChatId ? "block" : "hidden md:block"}`}>
          {selectedChatId ? (
            <ThreadView
              messages={messages}
              tasks={tasks}
              loading={loadingMessages}
              onBack={() => setSelectedChatId(null)}
              chatId={selectedChatId}
              thread={threads.find((t) => t.chat_id === selectedChatId)}
              locale={locale as string}
              onMessageSent={() => {
                // Re-fetch immediately rather than waiting for the next
                // poll tick — the optimistic insert on the backend already
                // wrote the row, so this just refreshes the list.
                if (selectedChatId) loadMessages(selectedChatId);
                loadThreads();
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
