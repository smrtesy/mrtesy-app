"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { MessageCircle } from "lucide-react";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";

/**
 * Floating desktop toggle that opens the docked WhatsApp panel. Hidden once
 * the panel is open (the panel carries its own close button) and on the full
 * /whatsapp page (where the panel would be redundant). Mobile uses the bottom
 * nav's WhatsApp tab instead, so this is desktop-only.
 */
export function WhatsAppPanelFab() {
  const { isOpen, open } = useWhatsAppPanel();
  const pathname = usePathname();
  const t = useTranslations("whatsappPage");

  if (isOpen) return null;
  if (pathname && pathname.includes("/whatsapp")) return null;

  return (
    <button
      type="button"
      onClick={open}
      aria-label={t("openPanel")}
      title={t("openPanel")}
      className="fixed bottom-5 end-5 z-40 hidden h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:opacity-90 md:inline-flex"
    >
      <MessageCircle className="h-5 w-5" />
    </button>
  );
}
