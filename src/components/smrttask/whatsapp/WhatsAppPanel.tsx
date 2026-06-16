"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Maximize2 } from "lucide-react";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { WhatsAppReader } from "./WhatsAppReader";

/**
 * Docked WhatsApp side-panel. On desktop it occupies the inline-end half of
 * the viewport (the main content is pushed aside by `body[data-wa-panel]` in
 * globals.css); on mobile it covers the screen as a full overlay. Mounted once
 * in the app shell — renders nothing until the panel is opened.
 */
export function WhatsAppPanel() {
  const { isOpen, seedChatId, seedDraft, session, close } = useWhatsAppPanel();
  const pathname = usePathname();
  const { locale } = useParams();
  const t = useTranslations("whatsappPage");
  const isHe = locale === "he";

  // Track the conversation actually open in the reader so "expand" lands on it.
  const [activeChatId, setActiveChatId] = useState<string | null>(seedChatId);

  // The full /whatsapp page already is the reader — don't stack a second copy
  // (or squeeze that page) on top of it.
  const onWhatsAppPage = Boolean(pathname && pathname.includes("/whatsapp"));
  const visible = isOpen && !onWhatsAppPage;

  // Push the main content aside on desktop while the panel is docked.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) document.body.setAttribute("data-wa-panel", "true");
    else document.body.removeAttribute("data-wa-panel");
    return () => {
      document.body.removeAttribute("data-wa-panel");
    };
  }, [visible]);

  if (!visible) return null;

  const expandHref = activeChatId
    ? `/${locale}/whatsapp?chat_id=${encodeURIComponent(activeChatId)}`
    : `/${locale}/whatsapp`;

  return (
    <aside
      dir={isHe ? "rtl" : "ltr"}
      aria-label={t("title")}
      className="fixed inset-0 z-[60] flex flex-col bg-card md:inset-y-0 md:end-0 md:start-auto md:w-[50vw] md:border-s md:shadow-xl"
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 p-2">
        <span className="flex-1 truncate text-sm font-semibold">{t("title")}</span>
        <Link
          href={expandHref}
          onClick={close}
          title={t("expandFull")}
          aria-label={t("expandFull")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Maximize2 className="h-4 w-4" />
        </Link>
        <button
          type="button"
          onClick={close}
          title={t("closePanel")}
          aria-label={t("closePanel")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <WhatsAppReader
        key={session}
        layout="stacked"
        initialChatId={seedChatId}
        initialDraft={seedDraft}
        onActiveChatChange={setActiveChatId}
        className="flex-1 p-2"
      />
    </aside>
  );
}
