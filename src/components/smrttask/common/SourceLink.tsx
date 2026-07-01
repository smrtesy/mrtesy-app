"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Mail, MessageCircle, MessageSquare, FolderOpen, Calendar, FileQuestion, ExternalLink, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { SourceMessageReader } from "./SourceMessageReader";


const SOURCE_ICONS: Record<string, typeof Mail> = {
  gmail:           Mail,
  gmail_sent:      Send,
  whatsapp:        MessageCircle,
  whatsapp_echo:   MessageCircle,
  sms:             MessageSquare,
  google_drive:    FolderOpen,
  google_calendar: Calendar,
};

type SourceRow = {
  /** source_messages PK — needed to open the in-app reader on mobile Gmail */
  id?: string | null;
  source_type: string | null;
  /** Burst/echo source id (`wa:<chatId>:<wamid>`) — lets us deep-link the
   *  WhatsApp reader straight to the exact message, not just the chat. */
  source_id?: string | null;
  source_url: string | null;
  serial_display: string | null;
};

interface SourceLinkProps {
  /**
   * From the source_messages join — null/undefined renders nothing.
   * Accepts either the joined object or a 1-element array (Supabase
   * sometimes returns the latter when it can't infer the FK direction).
   */
  source: SourceRow | SourceRow[] | null | undefined;
  /** Stop click propagation (e.g. inside a Card that has its own onClick) */
  stopPropagation?: boolean;
  className?: string;
}

/**
 * Small badge showing the source serial (G42 / W7 / D3 / …) with an icon for
 * the source type. If the source row has a URL the badge becomes a link that
 * opens the original message/doc in a new tab.
 */
export function SourceLink({ source, stopPropagation, className }: SourceLinkProps) {
  const waPanel = useWhatsAppPanel();
  const router = useRouter();
  const { locale } = useParams() as { locale: string };
  const row: SourceRow | null = Array.isArray(source) ? (source[0] ?? null) : (source ?? null);

  // In-app email reader, opened on mobile Gmail taps (see handleClick below).
  const [readerOpen, setReaderOpen] = useState(false);

  if (!row?.serial_display && !row?.source_url) return null;

  const Icon = SOURCE_ICONS[row.source_type ?? ""] ?? FileQuestion;
  const label = row.serial_display ?? "?";

  const base = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted/40";
  const interactive = "hover:bg-muted hover:text-foreground transition-colors";

  // WhatsApp sources route to the in-app reader rather than wa.me — the user
  // wants the conversation in the platform thread view, not a new chat in the
  // native WhatsApp client.
  const isWhatsapp = row.source_type === "whatsapp" || row.source_type === "whatsapp_echo";
  if (isWhatsapp) {
    // Backend stores wa.me/<digits-only>; we still strip non-digits defensively
    // so a malformed URL (e.g. wa.me/+972…) degrades to "open the chat list"
    // rather than silently opening an unknown conversation.
    const phone = ((row.source_url ?? "").match(/wa\.me\/([^?#]+)/)?.[1] ?? "").replace(/\D/g, "");
    // Parse the originating message id from the burst/echo source_id
    // (`wa:<chatId>:<wamid>`). Legacy thread rows (`wa:<chatId>`) carry no
    // wamid → we just open the chat. wamids never contain ':' so taking the
    // tail after the second colon is safe.
    const sid = row.source_id ?? "";
    let focusWamid: string | null = null;
    if (sid.startsWith("wa:")) {
      const idx = sid.indexOf(":", 3);
      if (idx > 0) focusWamid = sid.slice(idx + 1) || null;
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          // Surface the conversation in the docked side-panel — keeps the
          // current list (tasks/inbox/log) in place instead of navigating away.
          // When we know the exact source message, jump straight to it.
          if (phone) waPanel.openChat(phone, null, focusWamid);
          else waPanel.open();
        }}
        title={`${label} — open in WhatsApp`}
        className={cn(base, interactive, className)}
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
      </button>
    );
  }

  // SMS sources open the in-app SMS reader on the matching conversation, not the
  // native sms: link. The peer is stored verbatim in source_url as `sms:<peer>`.
  if (row.source_type === "sms") {
    const peer = (row.source_url ?? "").startsWith("sms:") ? (row.source_url as string).slice(4) : "";
    return (
      <button
        type="button"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          router.push(peer ? `/${locale}/sms?chat_id=${encodeURIComponent(peer)}` : `/${locale}/sms`);
        }}
        title={`${label} — open in SMS`}
        className={cn(base, interactive, className)}
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
      </button>
    );
  }

  if (row.source_url) {
    const isGmail = row.source_type === "gmail" || row.source_type === "gmail_sent";
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (stopPropagation) e.stopPropagation();
      if (typeof window === "undefined") return;
      // Gate on the actual device, not viewport width: a narrow desktop window
      // (split panel, zoom) must still open Gmail directly — the deep link only
      // breaks on real phones. UA detection keeps desktop on the direct link.
      const isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
      if (!isMobile) return;
      // Mobile Gmail can't deep-link to a specific message — both the app and
      // m.gmail web ignore the "#all/<id>" fragment and land on the inbox. So
      // on mobile we open the email's stored content in the in-app reader
      // instead of navigating to Gmail.
      if (isGmail && row.id) {
        e.preventDefault();
        setReaderOpen(true);
        return;
      }
      // Other mobile sources (Drive, Calendar): same-tab nav so the OS / app
      // can intercept the URL instead of opening a dead background tab.
      e.currentTarget.target = "_self";
    };

    return (
      <>
        <a
          href={row.source_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleClick}
          title={`${label} — open source`}
          className={cn(base, interactive, className)}
        >
          <Icon className="h-3 w-3" />
          <span>{label}</span>
          <ExternalLink className="h-2.5 w-2.5 opacity-70" />
        </a>
        {isGmail && row.id && (
          <SourceMessageReader
            sourceMessageId={row.id}
            open={readerOpen}
            onClose={() => setReaderOpen(false)}
          />
        )}
      </>
    );
  }

  // Has serial but no URL — just a tag, not clickable
  return (
    <span title={label} className={cn(base, className)}>
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </span>
  );
}
