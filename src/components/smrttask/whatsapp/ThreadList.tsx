"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeftRight, Loader2, MessageSquare, CheckSquare, Reply, Send, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/icon-button";
import { detectMessageDir } from "./utils";

export interface Thread {
  chat_id: string;
  last_message_at: string;
  last_direction: "incoming" | "outgoing";
  last_message_type: string;
  last_body_text: string | null;
  from_phone: string;
  from_name: string | null;
  /** User-defined override for the contact's display name. When non-null,
   *  takes priority over `from_name` everywhere (list, header, and the
   *  `sender` field on source_messages used by the smrtTask classifier). */
  custom_name?: string | null;
  is_history: boolean;
  unread_count?: number;
  task_count?: number;
  /** wamid of the newest message (any direction). The default target the
   *  quick-reply composer quotes when "reply to last message" is checked. */
  last_wamid?: string | null;
  /** received_at of the newest incoming message — drives the 24h free-form
   *  send window (Meta rule) for the quick-reply affordance, computed
   *  client-side exactly like ThreadView does. */
  last_incoming_at?: string | null;
}

interface Props {
  threads: Thread[];
  loading: boolean;
  selectedChatId: string | null;
  onSelect: (chatId: string) => void;
  emptyLabel: string;
  /** Fired after a quick reply is sent so the parent can refetch the thread
   *  list (and the open conversation, if it's this chat) — the new outgoing
   *  message then shows as the row preview. */
  onQuickReplySent?: (chatId: string) => void;
}

// Mirrors ThreadView / the server: free-form sends are only allowed within
// 24h of the contact's last incoming message.
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Compact one-line-per-chat list, ordered newest first by the parent.
 * The display name is the WhatsApp profile name we captured on the last
 * incoming message, falling back to the phone number when we never got
 * one (groups, outgoing-only chats, etc.).
 *
 * Each row carries a quiet quick-reply affordance (compact-UI: collapsed by
 * default behind a small reply icon). Clicking it expands an inline composer
 * so the operator can answer a chat straight from the list — quoting the last
 * message by default, or sending a plain message when that box is unchecked —
 * without opening the conversation.
 */
export function ThreadList({ threads, loading, selectedChatId, onSelect, emptyLabel, onQuickReplySent }: Props) {
  const t = useTranslations("whatsappPage");

  // Which chat's inline quick-reply composer is open (null = all collapsed).
  const [quickReplyChatId, setQuickReplyChatId] = useState<string | null>(null);
  const [quickReplyText, setQuickReplyText] = useState("");
  // Checked by default → the send quotes the chat's last message. Unchecking
  // it sends a plain message (no quote), per the operator's request.
  const [quoteLast, setQuoteLast] = useState(true);
  const [sending, setSending] = useState(false);

  const openQuickReply = useCallback((chatId: string) => {
    setQuickReplyChatId(chatId);
    setQuickReplyText("");
    setQuoteLast(true);
  }, []);

  const closeQuickReply = useCallback(() => {
    setQuickReplyChatId(null);
    setQuickReplyText("");
  }, []);

  const submitQuickReply = useCallback(
    async (th: Thread) => {
      const trimmed = quickReplyText.trim();
      if (!trimmed || sending) return;
      setSending(true);
      try {
        await api("/api/whatsapp/messages/send", {
          method: "POST",
          body: {
            to_phone: th.chat_id,
            text: trimmed,
            // Only quote when the box is checked AND we actually have a target.
            ...(quoteLast && th.last_wamid ? { reply_to_wamid: th.last_wamid } : {}),
          },
        });
        setQuickReplyChatId(null);
        setQuickReplyText("");
        toast.success(t("quickReplySent"));
        onQuickReplySent?.(th.chat_id);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [quickReplyText, quoteLast, sending, t, onQuickReplySent],
  );

  if (loading && threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="h-full overflow-y-auto rounded-lg border bg-card divide-y">
      {threads.map((th) => {
        const isSelected = th.chat_id === selectedChatId;
        const displayName =
          th.custom_name?.trim() || th.from_name?.trim() || th.from_phone || th.chat_id;
        const preview = th.last_body_text?.trim() || `[${th.last_message_type}]`;
        const previewDir = detectMessageDir(preview);
        const nameDir = detectMessageDir(displayName);
        const unread = th.unread_count ?? 0;
        const taskCount = th.task_count ?? 0;
        const hasUnread = unread > 0;
        const isReplyOpen = th.chat_id === quickReplyChatId;
        // Free-form send only inside the 24h window (same rule the server
        // enforces). Outside it, the quick-reply icon is disabled with a note.
        const withinWindow =
          !!th.last_incoming_at &&
          Date.now() - new Date(th.last_incoming_at).getTime() < SEND_WINDOW_MS;
        const replyDir =
          detectMessageDir(quickReplyText) === "rtl" || quickReplyText.trim() === ""
            ? "rtl"
            : "ltr";

        return (
          <li key={th.chat_id} className={isReplyOpen ? "bg-muted/40" : ""}>
            {/* Row: selecting the chat and the quick-reply toggle are siblings
                (not nested) so we never put a button inside a button. */}
            <div className={`group flex items-stretch ${isSelected ? "bg-muted" : ""}`}>
              <button
                type="button"
                onClick={() => onSelect(th.chat_id)}
                className="min-w-0 flex-1 px-3 py-2 text-start transition hover:bg-muted/60"
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-sm truncate ${hasUnread ? "font-semibold" : "font-medium"}`}
                        dir={nameDir}
                      >
                        {displayName}
                      </span>
                      {th.last_direction === "outgoing" && (
                        <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" aria-label={t("outgoing")} />
                      )}
                      {th.is_history && (
                        <span className="text-[10px] px-1 rounded bg-status-warn-bg text-status-warn shrink-0">
                          {t("history")}
                        </span>
                      )}
                    </div>
                    <p
                      className={`text-xs truncate mt-0.5 ${
                        hasUnread ? "font-medium text-foreground" : "text-muted-foreground"
                      }`}
                      dir={previewDir}
                    >
                      {preview.slice(0, 120)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span
                      className={`text-[10px] ${
                        hasUnread ? "font-medium text-status-ok" : "text-muted-foreground"
                      }`}
                    >
                      {formatRelative(th.last_message_at)}
                    </span>
                    <div className="flex gap-1">
                      {taskCount > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-primary"
                          title={t("tasksFromChat", { count: taskCount })}
                        >
                          <CheckSquare className="h-2.5 w-2.5" />
                          {taskCount}
                        </span>
                      )}
                      {hasUnread && (
                        <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-status-ok px-1 text-[10px] font-bold text-white">
                          {unread > 99 ? "99+" : unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
              {/* Quiet quick-reply toggle. Subtle at rest, brightens on hover;
                  disabled (with the "why") outside the 24h window. */}
              <div className="flex shrink-0 items-center pe-1">
                <IconButton
                  label={withinWindow ? t("quickReply") : t("windowClosedShort")}
                  color="green"
                  side="left"
                  disabled={!withinWindow || sending}
                  aria-expanded={isReplyOpen}
                  className={`opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 ${
                    isReplyOpen ? "opacity-100 text-status-ok" : ""
                  }`}
                  onClick={() => (isReplyOpen ? closeQuickReply() : openQuickReply(th.chat_id))}
                >
                  <Reply />
                </IconButton>
              </div>
            </div>

            {/* Inline quick-reply composer — revealed only for the open row. */}
            {isReplyOpen && (
              <div className="px-3 pb-2 pt-1">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    dir={replyDir}
                    value={quickReplyText}
                    onChange={(e) => setQuickReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitQuickReply(th);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closeQuickReply();
                      }
                    }}
                    placeholder={t("quickReplyPlaceholder")}
                    aria-label={t("quickReply")}
                    disabled={sending}
                    className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <IconButton
                    label={t("send")}
                    color="green"
                    className="h-8 w-8 md:h-8 md:w-8 shrink-0"
                    disabled={sending || !quickReplyText.trim()}
                    onClick={() => void submitQuickReply(th)}
                  >
                    {sending ? <Loader2 className="animate-spin" /> : <Send />}
                  </IconButton>
                  <IconButton
                    label={t("cancelReply")}
                    color="neutral"
                    className="h-8 w-8 md:h-8 md:w-8 shrink-0"
                    disabled={sending}
                    onClick={closeQuickReply}
                  >
                    <X />
                  </IconButton>
                </div>
                {/* Quote toggle — checked = reply to the last message; unchecked
                    = send as a plain message. Hidden when there's no target. */}
                {th.last_wamid && (
                  <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={quoteLast}
                      onChange={(e) => setQuoteLast(e.target.checked)}
                      disabled={sending}
                      className="h-3.5 w-3.5 accent-status-ok"
                    />
                    {t("quickReplyQuoteLast")}
                  </label>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Coarse "just now / 3h / 2d / 14 May" formatter — locale-agnostic enough for a tooltip-less list. */
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

// `MessageSquare` import kept for future "type=group" icon. Suppress unused warning.
void MessageSquare;
