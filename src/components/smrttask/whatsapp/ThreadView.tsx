"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, Check, CheckCheck, AlertCircle, Loader2, FileText, Download, Send, SmilePlus, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import type { Thread } from "./ThreadList";
import { detectMessageDir } from "./utils";

export interface Message {
  id: string;
  wamid: string;
  chat_id: string;
  direction: "incoming" | "outgoing";
  from_phone: string;
  from_name: string | null;
  to_phone: string | null;
  message_type: string;
  body_text: string | null;
  media_id: string | null;
  media_mime: string | null;
  media_url: string | null;
  media_filename: string | null;
  media_size: number | null;
  reply_to_wamid: string | null;
  reaction_emoji: string | null;
  is_reaction: boolean;
  is_history: boolean;
  history_phase: number | null;
  received_at: string;
  // Read/delivery receipts — only populated for outgoing messages once
  // Meta sends us the corresponding `statuses` webhook event.
  status?: "sent" | "delivered" | "read" | "failed" | null;
  status_error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
}

export interface ChatTask {
  id: string;
  title: string | null;
  title_he: string | null;
  status: string | null;
  priority: string | null;
  created_at: string;
  due_date: string | null;
}

interface Props {
  messages: Message[];
  /** Tasks created from this chat (across the whole conversation history),
   *  passed through from the parent so we can render a per-message badge
   *  next to the message that most likely produced each task. */
  tasks: ChatTask[];
  loading: boolean;
  chatId: string;
  thread: Thread | undefined;
  locale: string;
  onBack: () => void;
  /** Called after a successful send so the parent can refetch immediately. */
  onMessageSent?: () => void;
}

const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export function ThreadView({ messages, tasks, loading, chatId, thread, locale, onBack, onMessageSent }: Props) {
  const t = useTranslations("whatsappPage");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Snap to bottom on initial load and when new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Build a lookup for reactions: target_wamid → reaction emojis.
  // We keep at most one reaction per direction (matches WhatsApp UX:
  // each side can leave one emoji per message; later reactions replace).
  const reactionsByTarget = new Map<string, Array<{ emoji: string; direction: string }>>();
  for (const m of messages) {
    if (m.is_reaction && m.reply_to_wamid && m.reaction_emoji) {
      const list = reactionsByTarget.get(m.reply_to_wamid) ?? [];
      // Replace earlier reactions from the same direction; keeps the latest.
      const filtered = list.filter((r) => r.direction !== m.direction);
      filtered.push({ emoji: m.reaction_emoji, direction: m.direction });
      reactionsByTarget.set(m.reply_to_wamid, filtered);
    }
  }

  const visibleMessages = messages.filter((m) => !m.is_reaction);

  const displayName = thread?.from_name?.trim() || thread?.from_phone || chatId;

  // Quick-lookup map for reply quotes — when a message has reply_to_wamid,
  // we want to surface the original message's preview above the bubble.
  const messagesByWamid = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.wamid, m);
    return map;
  }, [messages]);

  // Map each whatsapp_message → tasks that were most likely created from
  // it. Heuristic: each task is assigned to the LATEST message whose
  // received_at is at or before task.created_at — because Part 3
  // classifier runs on the freshly-updated thread, the triggering
  // message is the most recent one when the task is created.
  const tasksByMessageId = useMemo(() => {
    const map = new Map<string, ChatTask[]>();
    if (tasks.length === 0 || messages.length === 0) return map;
    // Messages are already chronological (oldest → newest) per the API.
    const messageList = messages.filter((m) => !m.is_reaction);
    for (const t of tasks) {
      const taskTime = new Date(t.created_at).getTime();
      // Find the LATEST message with received_at <= taskTime.
      let bestMessage: Message | null = null;
      for (const m of messageList) {
        if (!m.received_at) continue;
        const mt = new Date(m.received_at).getTime();
        if (mt <= taskTime) bestMessage = m;
        else break; // messages are sorted, so we can stop
      }
      if (bestMessage) {
        const existing = map.get(bestMessage.id) ?? [];
        existing.push(t);
        map.set(bestMessage.id, existing);
      }
    }
    return map;
  }, [tasks, messages]);

  // "Last seen" approximation. The Meta Cloud API doesn't expose real
  // presence/last-seen for arbitrary contacts (that's a WhatsApp consumer
  // privacy feature). The best signal we have is the most recent moment we
  // know the contact had WhatsApp open: either an incoming message they
  // sent, or a `read` receipt on something we sent. We take the max.
  const lastSeenAt = useMemo(() => {
    let best: number | null = null;
    for (const m of messages) {
      if (m.is_reaction) continue;
      if (m.direction === "incoming" && m.received_at) {
        const t = new Date(m.received_at).getTime();
        if (best === null || t > best) best = t;
      }
      if (m.direction === "outgoing" && m.read_at) {
        const t = new Date(m.read_at).getTime();
        if (best === null || t > best) best = t;
      }
    }
    return best ? new Date(best) : null;
  }, [messages]);

  // 24h-window status. We can compute it from the messages we already
  // have — find the most recent incoming message; if it's within 24h,
  // free-form sending is allowed.
  const { withinWindow, windowExpiresAt } = useMemo(() => {
    const latestIncoming = [...messages]
      .reverse()
      .find((m) => m.direction === "incoming" && !m.is_reaction);
    if (!latestIncoming?.received_at) {
      return { withinWindow: false as const, windowExpiresAt: null };
    }
    const t = new Date(latestIncoming.received_at).getTime();
    const expires = t + SEND_WINDOW_MS;
    return {
      withinWindow: Date.now() < expires,
      windowExpiresAt: new Date(expires),
    };
  }, [messages]);

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b bg-muted/40 p-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label={t("back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate">{displayName}</p>
          {/* Sub-line: "active a few minutes ago" approximation from
              incoming + read receipts (real WhatsApp last-seen isn't
              exposed by the Cloud API). Fall back to phone if no activity. */}
          {lastSeenAt ? (
            <p className="text-xs text-muted-foreground truncate">
              {formatLastSeen(lastSeenAt, t)}
            </p>
          ) : (
            thread?.from_phone && thread.from_phone !== displayName && (
              <p className="text-xs text-muted-foreground truncate" dir="ltr">
                {thread.from_phone}
              </p>
            )
          )}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Messages — force LTR on the container so the per-message
          alignment logic below stays consistent regardless of the app's
          interface locale. Each bubble's own `dir` is set based on the
          language of its body_text. */}
      <div
        ref={scrollRef}
        dir="ltr"
        className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-[#f0f2f5]"
      >
        {visibleMessages.length === 0 && !loading && (
          <p className="text-center text-sm text-muted-foreground py-8">{t("emptyChat")}</p>
        )}
        {visibleMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            reactions={reactionsByTarget.get(m.wamid) ?? []}
            quotedMessage={m.reply_to_wamid ? messagesByWamid.get(m.reply_to_wamid) : undefined}
            relatedTasks={tasksByMessageId.get(m.id) ?? []}
            locale={locale}
            canReact={withinWindow}
            onReact={async (emoji) => {
              try {
                await api("/api/whatsapp/messages/react", {
                  method: "POST",
                  body: { target_wamid: m.wamid, emoji },
                });
                onMessageSent?.();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        ))}
      </div>

      {/* Compose box — Meta only allows free-form replies within 24h of the
          customer's last message. Outside the window, the input is disabled
          and we explain why. */}
      <ComposeBox
        chatId={chatId}
        withinWindow={withinWindow}
        windowExpiresAt={windowExpiresAt}
        onSent={onMessageSent}
      />
    </div>
  );
}

function ComposeBox({
  chatId,
  withinWindow,
  windowExpiresAt,
  onSent,
}: {
  chatId: string;
  withinWindow: boolean;
  windowExpiresAt: Date | null;
  onSent?: () => void;
}) {
  const t = useTranslations("whatsappPage");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Per-message direction inside the input itself so Hebrew & English both
  // render naturally. Defaults to RTL when the field is empty (the most
  // common case for our Hebrew-speaking operator).
  const dir = detectMessageDir(text) === "rtl" || text.trim() === "" ? "rtl" : "ltr";

  async function handleSend() {
    if (!text.trim() || sending) return;
    if (!withinWindow) {
      toast.error(t("windowClosedShort"));
      return;
    }
    setSending(true);
    try {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: { to_phone: chatId, text: text.trim() },
      });
      setText("");
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (standard chat UX).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t bg-muted/40 p-2 space-y-1.5">
      {!withinWindow && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {t("windowClosed")}
        </p>
      )}
      {withinWindow && windowExpiresAt && (
        <p className="text-[10px] text-muted-foreground">
          {t("windowOpenUntil", { time: windowExpiresAt.toLocaleString() })}
        </p>
      )}
      <div className="flex gap-2 items-end">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={withinWindow ? t("composePlaceholder") : t("composeDisabled")}
          disabled={!withinWindow || sending}
          dir={dir}
          rows={1}
          className="resize-none min-h-[40px] max-h-[140px] text-sm"
        />
        <Button
          type="button"
          onClick={handleSend}
          disabled={!withinWindow || !text.trim() || sending}
          size="icon"
          aria-label={t("send")}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Quick-react palette — the same six emojis WhatsApp Web shows by default. */
const QUICK_EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"] as const;

function MessageBubble({
  message,
  reactions,
  quotedMessage,
  relatedTasks,
  locale,
  canReact,
  onReact,
}: {
  message: Message;
  reactions: Array<{ emoji: string; direction: string }>;
  /** The original message this one replies to, if it's in the loaded thread. */
  quotedMessage?: Message;
  /** Tasks created from this specific message (heuristic match). */
  relatedTasks: ChatTask[];
  locale: string;
  /** When false, the react button is hidden (24h window closed). */
  canReact: boolean;
  /** Called with the selected emoji (or "" to remove). */
  onReact: (emoji: string) => void;
}) {
  const t = useTranslations("whatsappPage");
  const isOutgoing = message.direction === "outgoing";

  // Reaction-picker visibility per bubble. Click the react button to
  // toggle. We close on outside click via a one-shot effect below.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  // The user's currently-active reaction on THIS message (so the picker
  // can highlight it, and clicking again removes it).
  const myReaction = reactions.find((r) => r.direction === "outgoing")?.emoji ?? null;

  // Images: render inline. Other media (docs, etc.): fetch a fresh signed URL
  // on click and open in a new tab. We hold the signed URL in state so that
  // for images the <img> below has a real src and can render right away.
  const [imageSignedUrl, setImageSignedUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);

  const isImage = message.message_type === "image" && Boolean(message.media_url);

  useEffect(() => {
    if (!isImage || !message.media_url) return;
    let cancelled = false;
    setImageLoading(true);
    api<{ url: string }>(
      `/api/whatsapp/media?path=${encodeURIComponent(message.media_url)}`,
    )
      .then(({ url }) => {
        if (!cancelled) setImageSignedUrl(url);
      })
      .catch((e) => {
        if (!cancelled) console.error("image signed URL failed:", e);
      })
      .finally(() => {
        if (!cancelled) setImageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, message.media_url]);

  async function openMedia() {
    if (!message.media_url) return;
    try {
      const { url } = await api<{ url: string }>(
        `/api/whatsapp/media?path=${encodeURIComponent(message.media_url)}`,
      );
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const ts = new Date(message.received_at);

  // Per-message direction: determined by the language of the body, NOT by
  // who sent it. Hebrew/Arabic content sits on the right edge; Latin
  // content on the left. Color (green vs white) is what tells the user
  // whether the message is outgoing or incoming.
  const msgDir = detectMessageDir(message.body_text);
  const flexAlign = msgDir === "rtl" ? "justify-end" : "justify-start";

  return (
    <div className={`group flex flex-col ${flexAlign}`}>
      <div className={`relative flex items-center gap-1 ${flexAlign}`}>
        {/* React button — hidden by default, appears on hover. Placed on
            the OPPOSITE edge of the bubble's alignment so it doesn't crowd
            the content side. */}
        {canReact && msgDir === "rtl" && (
          <ReactionButton
            myReaction={myReaction}
            pickerOpen={pickerOpen}
            pickerRef={pickerRef}
            onTogglePicker={() => setPickerOpen((v) => !v)}
            onPick={(emoji) => {
              setPickerOpen(false);
              onReact(emoji);
            }}
          />
        )}
        <div
          dir={msgDir}
          className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm shadow-sm ${
            isOutgoing
              ? "bg-emerald-100 text-emerald-950"
              : "bg-white text-gray-900"
          }`}
        >
        {message.from_name && !isOutgoing && (
          <p className="text-[11px] font-medium text-emerald-700">{message.from_name}</p>
        )}

        {/* Reply quote — when this message is a reply to a previous one,
            mimic WhatsApp's stacked-quote UI with a left/right accent bar
            and a one-line preview of the original. */}
        {quotedMessage && (
          <div
            className={`mb-1.5 rounded border-s-4 bg-black/[0.04] px-2 py-1 text-xs ${
              quotedMessage.direction === "outgoing"
                ? "border-emerald-500"
                : "border-blue-500"
            }`}
            dir={detectMessageDir(quotedMessage.body_text)}
          >
            <p className="text-[10px] font-medium text-muted-foreground">
              {quotedMessage.direction === "outgoing"
                ? t("you")
                : quotedMessage.from_name?.trim() || quotedMessage.from_phone || t("contact")}
            </p>
            <p className="line-clamp-2 break-words text-[11px] text-muted-foreground/80">
              {quotedMessage.body_text?.slice(0, 200) || `[${quotedMessage.message_type}]`}
            </p>
          </div>
        )}

        {/* Image preview — render before the body so the picture is what
            the user sees first, with the OCR/caption as supplementary text. */}
        {isImage && (
          <div className="mt-1 mb-1.5">
            {imageSignedUrl ? (
              <button
                type="button"
                onClick={() => imageSignedUrl && window.open(imageSignedUrl, "_blank", "noopener")}
                className="block overflow-hidden rounded-md"
                aria-label={t("openDocument")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageSignedUrl}
                  alt=""
                  className="max-h-[280px] max-w-full rounded-md object-contain bg-black/5"
                />
              </button>
            ) : imageLoading ? (
              <div className="h-32 w-48 animate-pulse rounded-md bg-black/10" />
            ) : (
              <div className="h-32 w-48 rounded-md bg-black/10" />
            )}
          </div>
        )}

        {message.body_text && (
          <p className="whitespace-pre-wrap break-words leading-snug">{message.body_text}</p>
        )}

        {/* Non-image media (documents, etc.) keep the download-button UX. */}
        {message.media_url && !isImage && (
          <button
            type="button"
            onClick={openMedia}
            className="mt-1.5 flex items-center gap-1.5 rounded border bg-white/70 px-2 py-1 text-xs text-blue-700 hover:bg-white"
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="truncate max-w-[200px]">
              {message.media_filename ?? t("openDocument")}
            </span>
            <Download className="h-3 w-3 ms-auto" />
          </button>
        )}

        {/* Tasks created from this message (heuristic match by created_at) —
            small inline links per task so the user can jump from the
            conversation context straight to the resulting task card. */}
        {relatedTasks.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {relatedTasks.map((task) => {
              const taskTitle =
                locale === "he" && task.title_he ? task.title_he : task.title ?? t("contact");
              return (
                <Link
                  key={task.id}
                  href={`/${locale}/tasks?focus=${task.id}`}
                  className="inline-flex items-center gap-1 self-start rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100 transition"
                  title={t("openTask")}
                >
                  <CheckSquare className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{taskTitle}</span>
                </Link>
              );
            })}
          </div>
        )}

        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-500">
          <span>
            {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.is_history && (
            <span className="rounded bg-amber-100 px-1 text-amber-700">{t("history")}</span>
          )}
          {/* WhatsApp-style delivery ticks on outgoing only.
              sent      → single grey check
              delivered → double grey checks (CheckCheck)
              read      → double blue checks (CheckCheck colored)
              failed    → red alert icon. */}
          {isOutgoing && <DeliveryReceipt status={message.status ?? null} />}
        </div>
        </div>
        {/* React button on the LTR side — same component, just rendered
            after the bubble so flex order puts it on the visual left. */}
        {canReact && msgDir === "ltr" && (
          <ReactionButton
            myReaction={myReaction}
            pickerOpen={pickerOpen}
            pickerRef={pickerRef}
            onTogglePicker={() => setPickerOpen((v) => !v)}
            onPick={(emoji) => {
              setPickerOpen(false);
              onReact(emoji);
            }}
          />
        )}
      </div>

      {/* Reactions — a compact pill UNDER the bubble (not inside it), the
          way WhatsApp renders them. We aggregate by emoji and show count. */}
      {reactions.length > 0 && (
        <div className={`mt-[-2px] flex ${flexAlign}`}>
          <div className="rounded-full border bg-white shadow-sm px-1.5 py-0.5 flex items-center gap-0.5 text-xs leading-none">
            {aggregateReactions(reactions).map(({ emoji, count }) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  // Tapping your own reaction removes it; tapping a peer's
                  // emoji applies the same emoji as YOUR reaction.
                  if (emoji === myReaction) onReact("");
                  else onReact(emoji);
                }}
                className="inline-flex items-center gap-0.5 hover:bg-muted/60 rounded px-1 transition"
                title={t("reactWith", { emoji })}
              >
                <span className="text-sm">{emoji}</span>
                {count > 1 && <span className="text-[10px] text-muted-foreground">{count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * WhatsApp-style delivery indicator for outgoing messages.
 * - null / sent              → single grey check (still in flight / accepted by Meta)
 * - delivered                → double grey checks
 * - read                     → double blue checks
 * - failed                   → red alert
 */
function DeliveryReceipt({ status }: { status: Message["status"] }) {
  if (status === "failed") {
    return <AlertCircle className="h-3.5 w-3.5 text-red-500" aria-label="failed" />;
  }
  if (status === "read") {
    return <CheckCheck className="h-3.5 w-3.5 text-blue-500" aria-label="read" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="h-3.5 w-3.5 text-gray-400" aria-label="delivered" />;
  }
  // sent or unknown: single check (Meta accepted the message).
  return <Check className="h-3.5 w-3.5 text-gray-400" aria-label="sent" />;
}

/**
 * Format the "last seen" line in the chat header. Real WhatsApp
 * last-seen isn't exposed by the Cloud API; we approximate from the
 * most recent incoming message or read receipt.
 */
function formatLastSeen(date: Date, t: (key: string, vals?: Record<string, string | number>) => string): string {
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 5) return t("activeNow");
  if (min < 60) return t("activeMinutesAgo", { count: min });
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return t("activeHoursAgo", { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 7) return t("activeDaysAgo", { count: days });
  return t("activeOnDate", { date: date.toLocaleDateString() });
}

/**
 * The compact smiley button + quick-react palette popover that floats
 * alongside each message bubble. WhatsApp Web shows this on hover; we
 * keep the same UX but make the button always discoverable on mobile
 * (where there's no hover).
 */
function ReactionButton({
  myReaction,
  pickerOpen,
  pickerRef,
  onTogglePicker,
  onPick,
}: {
  myReaction: string | null;
  pickerOpen: boolean;
  pickerRef: React.MutableRefObject<HTMLDivElement | null>;
  onTogglePicker: () => void;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="relative shrink-0" ref={pickerRef}>
      <button
        type="button"
        onClick={onTogglePicker}
        className="opacity-0 group-hover:opacity-100 transition rounded-full p-1 hover:bg-muted/60"
        aria-label="React"
      >
        <SmilePlus className="h-4 w-4 text-muted-foreground" />
      </button>
      {pickerOpen && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-10 rounded-full border bg-white shadow-lg px-1 py-1 flex gap-0.5">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e === myReaction ? "" : e)}
              className={`text-lg leading-none rounded-full w-8 h-8 flex items-center justify-center transition ${
                e === myReaction ? "bg-emerald-100 scale-110" : "hover:bg-muted/60"
              }`}
              title={e}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Group an array of `{ emoji, direction }` into `{ emoji, count }` —
 * one entry per unique emoji. Order: most-recently-added first
 * (so a fresh reaction sits at the start of the pill).
 */
function aggregateReactions(
  reactions: Array<{ emoji: string; direction: string }>,
): Array<{ emoji: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of reactions) {
    if (!r.emoji) continue;
    counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  }
  return [...counts.entries()].map(([emoji, count]) => ({ emoji, count }));
}
