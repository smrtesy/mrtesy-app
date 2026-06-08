/**
 * smrtBot — embeddable web-chat page (rendered inside the widget iframe).
 *
 * Public, anonymous, and locale-agnostic (excluded from the auth/i18n
 * middleware). The loader script (/smrtbot-widget.js) injects an iframe
 * pointing here. Because the page is served from our own origin, the widget's
 * API + Realtime calls are same-origin.
 */
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import WebChatWidget, { type WebChatLabels } from "@/components/smrtbot/web/WebChatWidget";
import heMessages from "@/messages/he.json";
import enMessages from "@/messages/en.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BotRow {
  name: string;
  web_enabled: boolean | null;
  web_accent_color: string | null;
  web_icon_url: string | null;
  web_title: string | null;
  web_subtitle: string | null;
  web_greeting: string | null;
}

async function loadBot(webKey: string): Promise<BotRow | null> {
  const db = createAdminSupabaseClient();
  if (!db || !webKey) return null;
  const { data } = await db
    .from("smrtbot_bots")
    .select("name, web_enabled, web_accent_color, web_icon_url, web_title, web_subtitle, web_greeting")
    .eq("web_key", webKey)
    .maybeSingle();
  return (data as BotRow | null) ?? null;
}

export default async function SmrtBotEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { key } = await params;
  const { lang } = await searchParams;
  const locale = lang === "en" ? "en" : "he";
  const dir = locale === "he" ? "rtl" : "ltr";
  const labels = (locale === "en" ? enMessages : heMessages).smrtBotWeb as WebChatLabels;

  const bot = await loadBot(key);

  if (!bot || !bot.web_enabled) {
    return (
      <div dir={dir} className="flex h-screen w-screen items-center justify-center bg-slate-50 px-6 text-center text-sm text-slate-500">
        {labels.unavailable}
      </div>
    );
  }

  return (
    <main className="h-screen w-screen overflow-hidden bg-transparent">
      <WebChatWidget
        botKey={key}
        botName={bot.name}
        accentColor={bot.web_accent_color ?? "#2563eb"}
        dir={dir}
        labels={labels}
        iconUrl={bot.web_icon_url}
        title={bot.web_title}
        subtitle={bot.web_subtitle}
        greeting={bot.web_greeting}
      />
    </main>
  );
}
