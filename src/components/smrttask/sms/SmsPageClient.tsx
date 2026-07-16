"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useOptionalPaneNav, useScreenSearchParams } from "@/lib/panes/nav";
import { SmsReader } from "./SmsReader";

/**
 * Full-page SMS reader. Two-pane on desktop (conversation list beside the
 * selected conversation), single-pane on mobile. Read-only — sending SMS from
 * the platform isn't supported in the phone's local-server mode. Mirrors the
 * WhatsApp page wrapper.
 */
export function SmsPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const paneNav = useOptionalPaneNav();
  const searchParams = useScreenSearchParams();
  const isHe = locale === "he";

  const initialPeer = searchParams.get("chat_id");

  // Drop the (app) layout's max-width / padding so the surface hits the edges.
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
          : "flex flex-col h-[calc(100dvh-3.5rem-var(--wc-bar-h,0px))] md:h-[calc(100dvh_-_var(--wc-bar-h,0px))] p-2 md:p-3"
      }
      dir={isHe ? "rtl" : "ltr"}
    >
      <h1 className="sr-only">{title}</h1>
      <SmsReader initialPeer={initialPeer} seedKey={searchParams.toString()} className="flex-1" />
    </div>
  );
}
