"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Loader2, FileText, Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import type { Thread } from "./ThreadList";

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
}

interface Props {
  messages: Message[];
  loading: boolean;
  chatId: string;
  thread: Thread | undefined;
  onBack: () => void;
  /** Called after a successful send so the parent can refetch immediately. */
  onMessageSent?: () => void;
}

const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export function ThreadView({ messages, loading, chatId, thread, onBack, onMessageSent }: Props) {
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
          {thread?.from_phone && thread.from_phone !== displayName && (
            <p className="text-xs text-muted-foreground truncate" dir="ltr">
              {thread.from_phone}
            </p>
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
          <MessageBubble key={m.id} message={m} reactions={reactionsByTarget.get(m.wamid) ?? []} />
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

function MessageBubble({
  message,
  reactions,
}: {
  message: Message;
  reactions: Array<{ emoji: string; direction: string }>;
}) {
  const t = useTranslations("whatsappPage");
  const isOutgoing = message.direction === "outgoing";

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
    <div className={`flex ${flexAlign}`}>
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

        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-500">
          <span>
            {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.is_history && (
            <span className="rounded bg-amber-100 px-1 text-amber-700">{t("history")}</span>
          )}
          {isOutgoing && (
            <ArrowRight className="h-3 w-3" aria-label={t("outgoing")} />
          )}
        </div>

        {reactions.length > 0 && (
          <div className="mt-1 flex gap-0.5 text-base leading-none">
            {reactions.map((r, i) => (
              <span key={i} title={r.direction}>
                {r.emoji}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Decide whether a message body should render right-to-left (Hebrew /
 * Arabic / Yiddish) or left-to-right (everything else). We don't run a
 * full language detector — checking for the first script character in
 * the Hebrew or Arabic Unicode blocks is enough for our content.
 */
function detectMessageDir(text: string | null | undefined): "ltr" | "rtl" {
  if (!text) return "ltr";
  // Hebrew (0x0590-0x05FF) + Arabic (0x0600-0x06FF). The Unicode ranges
  // cover the script characters; emoji / numbers don't trip the check.
  return /[֐-ۿ]/.test(text) ? "rtl" : "ltr";
}
