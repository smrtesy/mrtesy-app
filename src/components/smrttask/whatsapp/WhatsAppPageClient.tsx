"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { ThreadList, type Thread } from "./ThreadList";
import { ThreadView, type Message, type ChatTask } from "./ThreadView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, MessageSquarePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";

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
    // Full-screen chat surface — no page title, no chat count. The two
    // panes already carry enough context (chat names on the left, header
    // inside the open thread on the right). h-[calc(100dvh-…)] uses
    // dynamic viewport units so the layout fills the screen even when
    // the mobile address bar collapses.
    //
    // We allow the page to overflow the outer app padding by pulling
    // negative margins; the parent layout adds px-4 py-4 around every
    // child. -mx-4 -my-4 cancels that for /whatsapp specifically so the
    // chat truly hits the edges of the viewport. The mobile bottom-nav
    // (h-12) still needs to fit, hence the per-breakpoint subtraction.
    <div
      className="-mx-4 -my-4 flex flex-col h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-1rem)]"
      dir={isHe ? "rtl" : "ltr"}
    >
      {/* Lightweight top bar: title kept off-screen for a11y, a small
          "new chat" button right of the title position so the rest of
          the area can be all chat. */}
      <div className="flex items-center justify-end gap-2 px-2 py-1 border-b bg-muted/30">
        <span className="sr-only">
          <MessageCircle className="h-5 w-5" />
          {title}
        </span>
        <NewChatButton
          onCreated={(chatId) => {
            // Open the brand-new thread and refresh the list so the new
            // chat appears in the sidebar.
            setSelectedChatId(chatId);
            loadThreads();
          }}
        />
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

/**
 * "+ New chat" button in the top bar. Opens a small modal asking for a
 * phone number and an opening message, then posts to the existing
 * /api/whatsapp/messages/send endpoint. WhatsApp's 24h-window rule still
 * applies — if the recipient has never messaged us, Meta will reject the
 * send with `outside_24h_window`. We surface that error inline so the
 * user understands they need a template (out of scope for this commit).
 */
function NewChatButton({ onCreated }: { onCreated: (chatId: string) => void }) {
  const t = useTranslations("whatsappPage");
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!dialogRef.current) return;
      if (!dialogRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleSend() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8) {
      toast.error(t("newChatInvalidPhone"));
      return;
    }
    if (!text.trim()) {
      toast.error(t("newChatNeedText"));
      return;
    }
    setSubmitting(true);
    try {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: { to_phone: digits, text: text.trim() },
      });
      setPhone("");
      setText("");
      setOpen(false);
      onCreated(digits);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The backend returns code "outside_24h_window" when the recipient
      // hasn't initiated. Translate to a friendly hint.
      if (/outside_24h_window/.test(msg)) {
        toast.error(t("newChatWindowClosed"));
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="gap-1"
      >
        <MessageSquarePlus className="h-4 w-4" />
        <span className="hidden sm:inline">{t("newChat")}</span>
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center p-4">
          <div
            ref={dialogRef}
            className="mt-20 w-full max-w-md rounded-lg border bg-card shadow-xl p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium">{t("newChatTitle")}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={t("close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground">{t("newChatHint")}</p>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("newChatPhoneLabel")}</label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+972501234567"
                dir="ltr"
                className="font-mono"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("newChatMessageLabel")}</label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("composePlaceholder")}
                rows={3}
                className="text-sm"
              />
            </div>

            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              {t("newChatTemplateWarning")}
            </p>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t("close")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSend}
                disabled={submitting || !phone.trim() || !text.trim()}
                className="gap-1"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("send")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
