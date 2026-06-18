/**
 * Web Push fan-out.
 *
 * Sends VAPID-signed push messages to a user's subscribed browsers/devices so
 * an installed PWA gets OS-level notifications even when it's not open. Wired
 * into the platform `notify()` helper, so every in-app notification also pushes.
 *
 * Configured via env (set these on the server host, e.g. Railway):
 *   VAPID_PUBLIC_KEY   — shared with the client to create subscriptions
 *   VAPID_PRIVATE_KEY  — secret signing key
 *   VAPID_SUBJECT      — a mailto: or https: contact URL (optional)
 *
 * If the keys are absent the sender no-ops, so the in-app notification path
 * keeps working and the app degrades gracefully without push configured.
 */
import webpush from "web-push";
import { db } from "../../db";

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@smrtesy.com";

  if (!publicKey || !privateKey) {
    console.warn("[push] VAPID keys not set — Web Push disabled");
    configured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  link?: string | null;
  type?: string;
  app_slug?: string;
  /** Collapses repeat notifications for the same entity into one banner. */
  tag?: string;
}

/**
 * Deliver a push to every subscription the user has. Best-effort: never throws,
 * and prunes subscriptions the push service reports as gone (404/410).
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) {
    console.error("[push] load subscriptions:", error.message);
    return;
  }
  if (!subs || subs.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? "",
    link: payload.link ?? "/",
    type: payload.type ?? "info",
    app_slug: payload.app_slug ?? "platform",
    tag: payload.tag,
  });

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err: unknown) {
        const code = (err as { statusCode?: number } | null)?.statusCode;
        if (code === 404 || code === 410) {
          // Subscription expired or was revoked by the browser — clean it up.
          await db.from("push_subscriptions").delete().eq("id", s.id);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[push] send failed:", code ?? "", message);
        }
      }
    }),
  );
}
