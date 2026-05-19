"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Loader2, FileText, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

export function ThreadView({ messages, loading, chatId, thread, onBack }: Props) {
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

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-[#f0f2f5]">
        {visibleMessages.length === 0 && !loading && (
          <p className="text-center text-sm text-muted-foreground py-8">{t("emptyChat")}</p>
        )}
        {visibleMessages.map((m) => (
          <MessageBubble key={m.id} message={m} reactions={reactionsByTarget.get(m.wamid) ?? []} />
        ))}
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

  // Click a stored document → ask backend for a fresh signed URL and open it.
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

  return (
    <div className={`flex ${isOutgoing ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm shadow-sm ${
          isOutgoing
            ? "bg-emerald-100 text-emerald-950"
            : "bg-white text-gray-900"
        }`}
      >
        {message.from_name && !isOutgoing && (
          <p className="text-[11px] font-medium text-emerald-700">{message.from_name}</p>
        )}

        {message.body_text && (
          <p className="whitespace-pre-wrap break-words leading-snug">{message.body_text}</p>
        )}

        {message.media_url && (
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
