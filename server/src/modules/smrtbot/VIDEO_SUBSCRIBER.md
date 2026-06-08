# smrtBot — subscriber video links (email identity + subscription gate)

The WhatsApp bot sends a video link to everyone. For a **verified subscriber**
the link carries a short-lived signed token so the video opens **directly**
(no login) on the external video site (`rebbek.org/<video_number>?t=<token>`).
Identity is by **email**; the WhatsApp phone is mapped → a verified email, and
**entitlement always comes from the external subscription system** — never
decided here. fail-closed: on any doubt the user gets the plain link.

## Dormant until configured

With none of the config keys set, the bot behaves **exactly as before** (raw
links, no onboarding). Set keys in `app_secrets` (slug `smrtbot`) via the admin
UI; secret values stored in Vault (`is_secret = true`).

| Key | Secret? | Purpose |
|---|---|---|
| `SUBSCRIPTION_API_BASE_URL` | no | Base URL of the external subscription system (e.g. `https://rebbek.org`) |
| `SUBSCRIPTION_API_SECRET` | yes | Bearer token we send to that system |
| `VIDEO_WATCH_BASE_URL` | no | Where video links point. Hebrew → `https://rebbek.org` → link is `<base>/<video_number>` |
| `VIDEO_TOKEN_SECRET` | yes | HMAC key signing the playback token |
| `VIDEO_VERIFY_SECRET` | yes | Bearer the video site sends to our verify endpoint |
| `VIDEO_OTP_FROM_EMAIL` | no | Verified SES sender for the OTP email |
| `VIDEO_OTP_SES_REGION` | no | SES region (default `us-east-1`) |

Onboarding (email collection) is active only when `SUBSCRIPTION_API_*` **and**
`VIDEO_OTP_FROM_EMAIL` are set. Token links activate when `VIDEO_WATCH_BASE_URL`
is set (token appended only when `VIDEO_TOKEN_SECRET` is also set).

## Flow

1. A WhatsApp user runs the `connect_email` action → enters email → receives a
   6-digit OTP by email → enters it → phone↔email linked (verified).
2. We `checkSubscription(email)` against the external system. If the email is
   unknown (`not_found`) we collect first/last name and `registerSubscriber()`
   pushes it back to the external system. Phone is taken from WhatsApp.
3. On every video send we `getSubscriberContext(phone)` (one external check per
   page) and build the link: subscriber → `<base>/<num>?t=<token>`, otherwise
   `<base>/<num>` (or the raw link if `VIDEO_WATCH_BASE_URL` is unset).

## Contracts

### External subscription system — **built by the operator** (keyed by email)

```
POST {SUBSCRIPTION_API_BASE_URL}/api/subscription/check
Authorization: Bearer {SUBSCRIPTION_API_SECRET}
{ "email": "user@example.com", "context": "whatsapp_link_request" }
→ 200 { "subscriber": true, "status": "active", "plan": "...",
        "expires_at": "ISO-8601|null", "customer": { "id": "...", "name": "..." } }
   200 { "subscriber": false, "status": "expired" }   // not a subscriber
   404                                                  // email unknown → not_found
```

```
POST {SUBSCRIPTION_API_BASE_URL}/api/subscription/register
Authorization: Bearer {SUBSCRIPTION_API_SECRET}
{ "email", "phone" (E.164), "first_name", "last_name", "name", "source":"whatsapp_bot", "registered_at" }
→ 200/201 { "ok": true, "customer_id": "...", "already_existed": false, "status": "registered" }
```

fail-closed: anything other than `200 { subscriber:true }` is treated as “not a
subscriber”. `404`/`not_found` triggers self-registration.

### Playback verification — **served by us, consumed by the video site**

`rebbek.org/<video_number>?t=<token>` → the page (which already plays the video)
calls us server-to-server to grant direct playback:

```
POST /api/smrtbot/playback/verify        (or GET ...?t=<token>)
Authorization: Bearer {VIDEO_VERIFY_SECRET}
{ "token": "<t from the URL>" }
→ 200 { "valid": true, "video": "123", "email": "...", "customer_id": "...", "expires_at": "ISO" }
   200 { "valid": false }                 // bad / expired token → fall back to normal login
   401 { "valid": false }                 // VIDEO_VERIFY_SECRET unset or wrong
```

Token staleness is bounded by its TTL (default 6h, `playback-token.ts`); it is
only ever minted for a verified subscriber.

## Device / app routing (future)

The bot can't see the user's OS (WhatsApp webhooks carry no device info). Device
detection happens when the link is opened (the page's `User-Agent`). For a native
app, register the same `https://rebbek.org/<num>` URL as an Android App Link /
iOS Universal Link: installed → opens in the app (token passes through), not
installed → opens the page. A `connect`/download button can deep-link to the
correct store via a `User-Agent` redirect.
