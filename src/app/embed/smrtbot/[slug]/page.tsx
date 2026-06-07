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
}

async function loadBot(slug: string): Promise<BotRow | null> {
  const db = createAdminSupabaseClient();
  if (!db) return null;
  const { data } = await db
    .from("smrtbot_bots")
    .select("name, web_enabled, web_accent_color")
    .eq("slug", slug)
    .maybeSingle();
  return (data as BotRow | null) ?? null;
}

export default async function SmrtBotEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { slug } = await params;
  const { lang } = await searchParams;
  const locale = lang === "en" ? "en" : "he";
  const dir = locale === "he" ? "rtl" : "ltr";
  const labels = (locale === "en" ? enMessages : heMessages).smrtBotWeb as WebChatLabels;

  const bot = await loadBot(slug);

  if (!bot || !bot.web_enabled) {
    return (
      <div dir={dir} className="flex h-screen w-screen items-center justify-center bg-slate-50 px-6 text-center text-sm text-slate-500">
        {locale === "he" ? "הצ׳אט אינו זמין כרגע." : "This chat is not available right now."}
      </div>
    );
  }

  return (
    <main className="h-screen w-screen overflow-hidden bg-transparent">
      <WebChatWidget
        slug={slug}
        botName={bot.name}
        accentColor={bot.web_accent_color ?? "#2563eb"}
        dir={dir}
        labels={labels}
      />
    </main>
  );
}
