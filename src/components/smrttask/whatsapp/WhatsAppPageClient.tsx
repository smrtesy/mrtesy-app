"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { ThreadList, type Thread } from "./ThreadList";
import { ThreadView, type Message, type ChatTask } from "./ThreadView";
import { MessageCircle } from "lucide-react";

/**
 * Two-pane WhatsApp reader. Left: chat list. Right: messages in the
 * selected chat. On mobile, the right pane takes over the whole screen
 * once a chat is selected (controlled by `selectedChatId`).
 */
export function WhatsAppPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const t = useTranslations("whatsappPage");
  const isHe = locale === "he";

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

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

  /** Fire-and-forget: tells the backend the user has opened this chat
   *  so the unread badge clears on the next /threads poll. */
  const markChatRead = useCallback(async (chatId: string) => {
    try {
      await api(`/api/whatsapp/threads/${encodeURIComponent(chatId)}/read`, {
        method: "POST",
      });
    } catch {
      // Best-effort — a stale unread badge is harmless.
    }
  }, []);

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
    // Take the full viewport height minus the app shell chrome. 100dvh
    // matters on mobile where the address bar can resize the viewport
    // — using just 100vh leaves a gap when the bar hides.
    <div
      className="flex flex-col h-[calc(100dvh-7rem)] md:h-[calc(100dvh-5rem)]"
      dir={isHe ? "rtl" : "ltr"}
    >
      <div className="flex items-center gap-2 px-2 pb-3">
        <MessageCircle className="h-5 w-5 text-emerald-600" />
        <h1 className="text-2xl font-bold">{title}</h1>
        <span className="text-xs text-muted-foreground ms-auto">
          {threads.length > 0 && t("threadCount", { count: threads.length })}
        </span>
      </div>

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
