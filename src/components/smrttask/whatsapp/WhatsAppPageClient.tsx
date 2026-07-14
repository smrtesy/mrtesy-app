"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useOptionalPaneNav, useScreenSearchParams } from "@/lib/panes/nav";
import { WhatsAppReader } from "./WhatsAppReader";

/**
 * Full-page WhatsApp reader. Two-pane on desktop (chat list beside the
 * selected conversation), single-pane on mobile. The shared data/polling
 * logic lives in <WhatsAppReader>; this wrapper only owns the full-screen
 * chrome and the body layout override.
 */
export function WhatsAppPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const paneNav = useOptionalPaneNav();
  const searchParams = useScreenSearchParams();
  const isHe = locale === "he";

  const initialChatId = searchParams.get("chat_id");
  const initialFocusWamid = searchParams.get("msg");

  // Tell the (app) layout to drop its max-width / padding wrapper so the chat
  // surface can hit the screen edges. Cleared on unmount so other pages get
  // their normal centered layout back. (Handled by globals.css.)
  useEffect(() => {
    // Inside a workspace pane the body attribute would leak onto the TOP
    // window (the pane container has no wrapper to strip) — skip it there.
    if (paneNav) return;
    document.body.setAttribute("data-chat-fullscreen", "true");
    return () => {
      document.body.removeAttribute("data-chat-fullscreen");
    };
  }, [paneNav]);

  return (
    <div
      className={
        paneNav
          ? // Pane mode: fill the pane body, not the viewport.
            "flex flex-col h-full p-2 md:p-3"
          : "flex flex-col h-[calc(100dvh-3.5rem)] md:h-[100dvh] p-2 md:p-3"
      }
      dir={isHe ? "rtl" : "ltr"}
    >
      {/* Accessibility-only title — the chat panes are the visible UI. */}
      <h1 className="sr-only">{title}</h1>
      <WhatsAppReader
        layout="split"
        initialChatId={initialChatId}
        seedKey={searchParams.toString()}
        initialFocusWamid={initialFocusWamid}
        className="flex-1"
      />
    </div>
  );
}
