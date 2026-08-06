# WhatsApp outbound migration — Meta direct → DualHook proxy

**Status:** code merged, flip-controlled by env (default OFF).
**Why now:** From **2026-08-05** DualHook enables Meta's **"Require App Secret"**
(`appsecret_proof`) on the sending app of our WhatsApp **Coexistence** connection.
Once on, Meta **declines** any outbound Cloud API request that does not carry the
app-secret signature. We cannot compute that signature ourselves, so outbound
calls must go **through DualHook** (`api.dualhook.com`), which holds the Meta
credential and signs each relayed request.

## Is this actually required? (research, 2026-07-30)

- `appsecret_proof` / "Require App Secret for Server API calls" is a **real,
  long-standing Meta feature** (App Dashboard → Settings → Advanced → Security).
  When enabled, unsigned Graph/Cloud API calls are rejected with
  *"API calls from the server require an appsecret_proof argument."* So the
  "requests without the signature are declined by Meta" claim is technically true.
- It is **NOT** a Meta platform-wide mandate or deadline. It is an **optional
  per-app toggle**; DualHook chose the date and controls the switch (their own
  wording: *"not a Meta-announced platform deadline. We control when the
  app-level requirement is enabled."*).
- We are on **Coexistence** (same number on the WhatsApp Business App **and** the
  Cloud API). Coexistence **requires a Tech Provider / BSP** — a number cannot be
  connected to the Cloud API directly, and can bind to only one provider at a
  time. So "sign it ourselves and keep calling Meta directly" is **not available**
  to us; a provider is inherent to Coexistence. DualHook is that provider.

Conclusion: for our setup the migration is the only path that keeps outbound
messaging and inbound media download working after 2026-08-05.

## The switch (env)

Both variables are read by `lib/whatsapp-endpoint.ts` (twin files — see below):

| Env var | Meaning | Default |
|---|---|---|
| `WHATSAPP_OUTBOUND_KEY` | DualHook connection-scoped `dh_live_` key. **Presence turns the proxy ON.** Secret — never commit. | unset (proxy OFF) |
| `WHATSAPP_API_HOST` | Host override. | `api.dualhook.com` when the key is set, else `graph.facebook.com` |

- **OFF (key unset):** byte-for-byte the previous direct-to-Meta behavior.
- **ON (key set):** host → `api.dualhook.com`, bearer → the `dh_live_` key.
- **Rollback:** unset `WHATSAPP_OUTBOUND_KEY` and redeploy.

The key must be set in **BOTH** runtimes (see "Where to set the env").

## Twin helpers

Because the outbound calls live in two separately-deployed runtimes, the helper
exists twice and must stay in sync (same pattern as `rule-filters.ts`):

- `server/src/lib/whatsapp-endpoint.ts` — Express backend (Railway).
- `src/lib/whatsapp-endpoint.ts` — Next route handlers (Vercel).

Exports: `whatsappApiBase()`, `whatsappBearer(metaToken)`, `whatsappViaProxy()`,
`whatsappOutboundKey()`.

## Call sites migrated

Only the **smrtTask personal number** (the Coexistence connection DualHook
provides) goes through the proxy. Every one of these call sites sends from that
one number:

| Runtime | File | Calls |
|---|---|---|
| Railway | `server/src/modules/smrttask/routes/whatsapp-view.ts` | send text/image, media upload (×2 each path) |
| Railway | `server/src/modules/smrttask/routes/transcription-experiment.ts` | media download |
| Vercel | `src/app/api/webhooks/whatsapp/autoreply.ts` | send auto-reply |
| Vercel | `src/app/api/webhooks/whatsapp/route.ts` | media download |

### NOT migrated — smrtBot is direct-to-Meta (do not route it through DualHook)

`server/src/modules/smrtbot/wa.ts` sends from the **smrtBot** phone numbers
(rl, sholem, …), which live on a **separate Meta app**, not the Coexistence
connection. DualHook's `dh_live_` key does not own those numbers, so routing
smrtBot through the proxy makes DualHook reject every send with HTTP 403
*"Credential is not valid for this phone number."* smrtBot therefore hard-codes
`graph.facebook.com` + the bot's own token and **ignores `WHATSAPP_OUTBOUND_KEY`
on purpose**. "Require App Secret" is not enabled on the smrtBot app, so no
`appsecret_proof` is needed. This was the original behavior; an earlier version
of this migration wrongly listed `wa.ts` as a proxy call site, which broke all
bot sends the moment the key was set (2026-08-05→06). Do not re-add it.

### Two non-obvious details

1. **Media download uses a different route when proxied.** Direct-to-Meta,
   `GET /{MEDIA_ID}` returns a one-time `lookaside.fbsbx.com` CDN URL we follow.
   That URL is not reachable through DualHook with the `dh_live_` key, so when the
   proxy is on we fetch bytes from DualHook's dedicated
   `GET /{MEDIA_ID}/content` route instead. Both downloaders branch on
   `whatsappViaProxy()`.
2. **`listTemplates` moved auth from the `access_token=` query param to an
   `Authorization: Bearer` header** — DualHook expects the key as a bearer; Meta
   accepts the header identically.

### Intentionally NOT migrated

`server/src/modules/admin/apps/routes.ts` → the `subscribed_apps` diagnostic
stays direct to Meta with the connection's **Meta** token: it needs a real Meta
System-User token and is not one of DualHook's supported relay routes.

## Where to set the env

The `dh_live_` key lives in the DualHook dashboard (connection "SS New" →
outbound API key). Copy it, then set `WHATSAPP_OUTBOUND_KEY` in **both**:

1. **Railway** → the backend service → **Variables** tab → add
   `WHATSAPP_OUTBOUND_KEY`. Railway redeploys the service.
2. **Vercel** → project → **Settings → Environment Variables** → add
   `WHATSAPP_OUTBOUND_KEY` (Production) → **Redeploy** so it takes effect.

Edge functions (Supabase) need nothing — no edge function calls Meta directly.

## Verify after flipping

1. Send a WhatsApp text from the `/whatsapp` screen to a chat inside the 24h
   window → it arrives.
2. Have someone send you a voice note / image → transcription / OCR still runs
   (this exercises the media-download `/content` path).
3. If anything fails, unset `WHATSAPP_OUTBOUND_KEY` and redeploy to roll back.

## DualHook supported routes (reference)

messages, media (upload/details/content/delete), message_templates (CRUD),
phone/WABA health, business profile, safe settings, QR codes — under
`/v25.0/...`. If a `v21.0`/`v23.0` path is ever rejected by DualHook, set
`META_API_VERSION=v25.0`.
