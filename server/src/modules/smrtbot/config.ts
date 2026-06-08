/**
 * smrtBot — per-bot config resolution.
 *
 * Each bot has its own domain (the Hebrew bot → rebbek.org, others → their
 * own), so subscription/video config is resolved PER BOT: a `smrtbot_settings`
 * (bot_id, key) row wins, falling back to the global `app_secrets` value
 * (slug "smrtbot", Vault-backed) for shared defaults / cryptographic secrets.
 *
 * Per-bot keys live in smrtbot_settings (plaintext, non-secret), e.g.
 *   VIDEO_WATCH_BASE_URL      = https://rebbek.org
 *   SUBSCRIPTION_API_BASE_URL = https://rebbek.org
 *   VIDEO_OTP_FROM_EMAIL      = noreply@rebbek.org
 *   BUNNY_LIBRARY_ID / BUNNY_CDN_HOSTNAME (video.rebbek.org) ...
 * Secrets (SUBSCRIPTION_API_SECRET, VIDEO_TOKEN_SECRET, VIDEO_VERIFY_SECRET,
 * Bunny token key) belong in app_secrets (Vault) unless a bot must override.
 */
import { db, getAppSecret } from "../../db";

export async function getBotConfig(botId: string, key: string, envFallback?: string): Promise<string | null> {
  const { data } = await db
    .from("smrtbot_settings")
    .select("value")
    .eq("bot_id", botId)
    .eq("key", key)
    .maybeSingle();
  const v = (data?.value as string | null) ?? null;
  if (v && v.trim() !== "") return v;
  return getAppSecret("smrtbot", key, envFallback);
}
