"use client";

import { useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { SmsReader } from "./SmsReader";

/**
 * Full-page SMS reader. Two-pane on desktop (conversation list beside the
 * selected conversation), single-pane on mobile. Read-only — sending SMS from
 * the platform isn't supported in the phone's local-server mode. Mirrors the
 * WhatsApp page wrapper.
 */
export function SmsPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const searchParams = useSearchParams();
  const isHe = locale === "he";

  const initialPeer = searchParams.get("chat_id");

  // Drop the (app) layout's max-width / padding so the surface hits the edges.
  useEffect(() => {
    document.body.setAttribute("data-chat-fullscreen", "true");
    return () => {
      document.body.removeAttribute("data-chat-fullscreen");
    };
  }, []);

  return (
    <div
      className="flex flex-col h-[calc(100dvh-3.5rem)] md:h-[100dvh] p-2 md:p-3"
      dir={isHe ? "rtl" : "ltr"}
    >
      <h1 className="sr-only">{title}</h1>
      <SmsReader initialPeer={initialPeer} className="flex-1" />
    </div>
  );
}
