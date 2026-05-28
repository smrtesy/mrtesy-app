"use client";

import { useTranslations } from "next-intl";
import { ArrowLeftRight, Loader2, MessageSquare, CheckSquare } from "lucide-react";
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
        const displayName =
          th.custom_name?.trim() || th.from_name?.trim() || th.from_phone || th.chat_id;
        const preview = th.last_body_text?.trim() || `[${th.last_message_type}]`;
        const previewDir = detectMessageDir(preview);
        const nameDir = detectMessageDir(displayName);
        const unread = th.unread_count ?? 0;
        const taskCount = th.task_count ?? 0;
        const hasUnread = unread > 0;

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
                      <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-700 shrink-0">
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
                      hasUnread ? "font-medium text-emerald-600" : "text-muted-foreground"
                    }`}
                  >
                    {formatRelative(th.last_message_at)}
                  </span>
                  <div className="flex gap-1">
                    {taskCount > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                        title={t("tasksFromChat", { count: taskCount })}
                      >
                        <CheckSquare className="h-2.5 w-2.5" />
                        {taskCount}
                      </span>
                    )}
                    {hasUnread && (
                      <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white">
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </div>
                </div>
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
