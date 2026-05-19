"use client";

import { useTranslations } from "next-intl";
import { ArrowLeftRight, Loader2, MessageSquare } from "lucide-react";

export interface Thread {
  chat_id: string;
  last_message_at: string;
  last_direction: "incoming" | "outgoing";
  last_message_type: string;
  last_body_text: string | null;
  from_phone: string;
  from_name: string | null;
  is_history: boolean;
}

interface Props {
  threads: Thread[];
  loading: boolean;
  selectedChatId: string | null;
  onSelect: (chatId: string) => void;
  emptyLabel: string;
}

/**
 * Compact one-line-per-chat list, ordered newest first by the parent.
 * The display name is the WhatsApp profile name we captured on the last
 * incoming message, falling back to the phone number when we never got
 * one (groups, outgoing-only chats, etc.).
 */
export function ThreadList({ threads, loading, selectedChatId, onSelect, emptyLabel }: Props) {
  const t = useTranslations("whatsappPage");

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
        const displayName = th.from_name?.trim() || th.from_phone || th.chat_id;
        const preview = th.last_body_text?.trim() || `[${th.last_message_type}]`;

        return (
          <li key={th.chat_id}>
            <button
              type="button"
              onClick={() => onSelect(th.chat_id)}
              className={`w-full text-start px-3 py-2 hover:bg-muted/60 transition ${
                isSelected ? "bg-muted" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">{displayName}</span>
                    {th.last_direction === "outgoing" && (
                      <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" aria-label={t("outgoing")} />
                    )}
                    {th.is_history && (
                      <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-700 shrink-0">
                        {t("history")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {preview.slice(0, 120)}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatRelative(th.last_message_at)}
                </span>
              </div>
            </button>
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
