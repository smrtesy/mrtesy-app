/**
 * WhatsApp Cloud API endpoint resolution — Meta direct vs DualHook proxy.
 *
 * By default every outbound WhatsApp Cloud API call (send message, upload/
 * download media, list templates) goes DIRECTLY to Meta at graph.facebook.com,
 * with the connection's Meta access token as the bearer.
 *
 * Setting WHATSAPP_OUTBOUND_KEY — a DualHook connection-scoped `dh_live_` key —
 * routes those calls through DualHook instead: the host flips to
 * api.dualhook.com (override with WHATSAPP_API_HOST) and the bearer becomes the
 * dh_live_ key. DualHook holds the Meta credential and adds Meta's app-secret
 * signature (appsecret_proof) to every relayed request. From 2026-08-05 DualHook
 * enables Meta's "Require App Secret" on the sending app, so unsigned direct
 * calls to graph.facebook.com are declined — this proxy is then the only working
 * path for our Coexistence connection. See
 * docs/whatsapp-dualhook-outbound-migration.md.
 *
 * Default-off and reversible: with WHATSAPP_OUTBOUND_KEY unset, behaviour is
 * byte-for-byte the previous direct-to-Meta path. Unsetting it rolls back.
 *
 * Scope: messaging / media / templates only. The admin `subscribed_apps`
 * diagnostic (modules/admin/apps/routes.ts) is deliberately NOT routed here — it
 * needs a real Meta System User token and hits a route DualHook does not proxy.
 *
 * Twin file: src/lib/whatsapp-endpoint.ts (Vercel/Next runtime). Keep the two in
 * sync — same env vars, same defaults.
 */

/** The DualHook `dh_live_` key, or null when outbound runs direct to Meta. */
export function whatsappOutboundKey(): string | null {
  return process.env.WHATSAPP_OUTBOUND_KEY?.trim() || null;
}

/** True when outbound WhatsApp traffic is routed through the DualHook proxy. */
export function whatsappViaProxy(): boolean {
  return whatsappOutboundKey() !== null;
}

/** Base origin for WhatsApp Cloud API calls, e.g. "https://graph.facebook.com". */
export function whatsappApiBase(): string {
  const host =
    process.env.WHATSAPP_API_HOST?.trim() ||
    (whatsappViaProxy() ? "api.dualhook.com" : "graph.facebook.com");
  return `https://${host}`;
}

/**
 * Bearer credential for an outbound WhatsApp call. Returns the DualHook
 * `dh_live_` key when the proxy is enabled, otherwise the caller's Meta token.
 */
export function whatsappBearer(metaToken: string): string {
  return whatsappOutboundKey() ?? metaToken;
}
