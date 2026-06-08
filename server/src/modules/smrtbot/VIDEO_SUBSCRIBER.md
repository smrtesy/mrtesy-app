# smrtBot — subscriber video (email gate + Bunny Stream, white-labelled)

Unified spec for the bot's gated video links. Two layers that compose:

- **Our subscription gate** decides **who is allowed** (identity by email →
  external entitlement). Built in this module.
- **Bunny Stream + a white-labelled player** handles **hosting, encoding,
  delivery and hot-link protection**, all under the bot's own domain.

Identity is by **email**; the WhatsApp phone maps → a verified email, and
**entitlement always comes from the external system** — never decided here.
fail-closed: on any doubt the user gets the plain link, never direct playback.

## Per-bot, per-domain

Each bot has its own domain (Hebrew bot → `rebbek.org`; others → their own) and
its own video CDN subdomain (`video.rebbek.org`). All config is resolved
**per bot** via `getBotConfig(botId, key)` (`config.ts`): a `smrtbot_settings`
(bot_id, key) row wins, else the global `app_secrets` value (slug `smrtbot`,
Vault-backed) is the fallback/default.

| Key | Scope | Example / notes |
|---|---|---|
| `VIDEO_WATCH_BASE_URL` | per-bot | `https://rebbek.org` → link is `<base>/<video_number>` |
| `VIDEO_LOCALE` | per-bot | the bot's locale, e.g. `he` / `en` — controls per-video availability (below) |
| `SUBSCRIPTION_API_BASE_URL` | per-bot | external subscription system for that domain |
| `SUBSCRIPTION_API_SECRET` | per-bot (Vault) | bearer we send to that system |
| `VIDEO_OTP_FROM_EMAIL` / `VIDEO_OTP_SES_REGION` | per-bot | verified SES sender (branding per domain) |
| `BUNNY_LIBRARY_ID` / `BUNNY_CDN_HOSTNAME` | per-bot | Bunny library + custom hostname `video.rebbek.org` |
| `BUNNY_TOKEN_KEY` | per-bot (Vault) | Bunny token-auth signing key (server-side only) |
| `VIDEO_TOKEN_SECRET` | platform (Vault) | HMAC key signing OUR playback token |
| `VIDEO_VERIFY_SECRET` | platform (Vault) | bearer the site sends to our verify endpoint |

Dormant until configured: with no `VIDEO_WATCH_BASE_URL`/subscription config the
bot behaves exactly as before (raw links, no onboarding).

## Unified flow

```
WhatsApp: bot sends  https://rebbek.org/<video_number>[?t=<our-token>]
   (verified subscriber → token appended; otherwise plain link)

Browser opens rebbek.org/<video_number>?t=...   (address bar: only rebbek.org)
   page backend (server-side):
     1. POST our /api/smrtbot/playback/verify { token }  → valid? video? email?
     2. if valid subscriber → sign a Bunny DIRECTORY token (server-side, BUNNY_TOKEN_KEY)
        and inject the tokenised master.m3u8 URL (video.rebbek.org/...) into the player
     3. else → no signed URL → show login / subscribe
   player (hybrid, no third-party video domain):
     - Safari/iOS  → native <video src=m3u8>   (AirPlay works)
     - Chrome/etc. → hls.js loadSource(m3u8)    (Google Cast works)
```

White-label: the page is on the bot domain; HLS + segments come from the per-bot
custom CDN hostname (`video.rebbek.org`, a CNAME to the Bunny pull zone); our
verify API is called **server-side** so the browser never sees it. No
`bunny.net` / `b-cdn.net` / `mediadelivery.net` appears in the Network tab.
(The Google Cast SDK loads from `gstatic.com` — the one unavoidable external
script if casting is enabled; it is not a video/CDN domain.)

## Onboarding (in WhatsApp chat)

`connect_email` action → enter email → 6-digit OTP by email (hashed at rest,
rate-limited, scoped to the pending email) → phone↔email linked →
`checkSubscription(email)`. If unknown (`not_found`) collect first/last name and
`registerSubscriber()` pushes it back to the external system (phone = the
WhatsApp number). See `identity.ts`.

## Contracts

### External subscription system — **built by the operator** (keyed by email)

```
POST {SUBSCRIPTION_API_BASE_URL}/api/subscription/check
Authorization: Bearer {SUBSCRIPTION_API_SECRET}
{ "email", "context":"whatsapp_link_request" }
→ 200 { subscriber, status, plan, expires_at, customer:{id,name} } | 404 (=not_found)

POST {SUBSCRIPTION_API_BASE_URL}/api/subscription/register
{ email, phone(E.164), first_name, last_name, name, source:"whatsapp_bot", registered_at }
→ 200/201 { ok, customer_id, already_existed, status }
```

### Playback verification — **served by us, consumed by the video site**

```
POST /api/smrtbot/playback/verify        (or GET ?t=<token>)
Authorization: Bearer {VIDEO_VERIFY_SECRET}
{ "token" }
→ 200 { valid:true, video, email, customer_id, expires_at } | { valid:false } | 401
```

Token TTL bounds staleness (default 6h, `playback-token.ts`); minted only for a
verified subscriber.

## Per-video availability (language / domain)

The catalog (`smrtbot_videos`) is org-wide, but each bot serves one
domain/locale. `smrtbot_videos.languages text[]` lists the locales a video is
available in; a bot (with `VIDEO_LOCALE` set) serves a video only when its
locale is in the array — or the array is NULL/empty (available everywhere,
back-compat). So an English-only video (`languages = {en}`) is never listed or
linked by the Hebrew bot. Same Hebrew videos shared across both domains →
`{he,en}`. Filtering happens in `videos.ts` (`allVideos`).

## Bunny Stream notes

- Storage/encoding/delivery only; **metadata, permissions, view tracking stay in
  Supabase** (`smrtbot_videos.bunny_video_guid` maps our video → Bunny GUID).
- Custom CDN hostname (CNAME) + Token Authentication V2 **directory tokens**
  (one token authorises the whole HLS path — required for segments, and works
  with native HLS for AirPlay). Sign the directory token **server-side**.
- Token must **not** be IP-locked, or casting breaks (the cast device fetches
  segments from its own IP).
- Migration from Vimeo: `npx vimeo2bunny` (fetches via Bunny's pull endpoint,
  preserves title/description/tags, resumable). Map the resulting GUIDs into
  `smrtbot_videos.bunny_video_guid`.

## Content protection — free baseline (chosen)

Decision: Bunny's **free** security layers + our gate. Enterprise multi-DRM
(Widevine/FairPlay/PlayReady) is an optional later upgrade, not used now.

Layers to enable (all free, all compatible with the hybrid hls.js/native player —
encryption is transparent to the player):
1. **HLS only, no MP4** — no single-file download link exists.
2. **Token Authentication V2** — directory token, short TTL, signed server-side,
   not IP-locked (see Bunny notes).
3. **Referrer / domain lock** — allowed domains = the bot's front domain(s)
   (`rebbek.org`, `mymaor.org`).
4. **AES-128 encryption + rotating keys** — segments encrypted.
5. **MediaCage Basic DRM** — per-session single-use keys (free; not hardware DRM).
6. **Brand watermark** (logo overlay).

Our layers on top (already built / planned):
- **Subscription gate** — only a verified subscriber gets a playable token.
- **Per-link use limit (2×)** — anti-forwarding (`smrtbot_playback_uses`).
- **Forensic overlay** *(player-side, we control)* — since the token identifies
  the subscriber (email/customer_id), the player can burn their email/phone as a
  faint on-video overlay → deters leaking and traces who leaked. This is our
  answer to screen-recording (which no non-DRM system prevents).

What this stops: casual download, link sharing / hot-linking, trivial ripping.
What it does NOT stop: determined ripping / screen recording — that needs
**Enterprise DRM** (paid; also requires EME license-flow integration in the
custom player, so it's a deliberate later decision). The forensic overlay is the
deterrent until/unless DRM is added.

## View tracking (built) — consuming views in other apps

Every successful `playback/verify` records a real-time, per-subscriber view in
two places, so any app can pull the data:

1. **`smrtbot_video_views`** (queryable log) — one row per authorized play:
   `org_id, bot_id, video, email, customer_id, jti, ip, user_agent, watched_at`.
   - smrtCRM: views per contact / per link → join on `email` (or `customer_id`).
   - dashboards: counts / trends / top videos → group by `video`, `watched_at`.
   - de-dupe a refresh by `jti` if you want unique-link views vs play events.
   (`ip`/`user_agent` are only populated if the site forwards the *viewer's* ip /
   user_agent in the verify request body — the request itself is server-to-server.)
2. **`video.viewed` app_event** (real-time stream) — emitted via `emitEvent`,
   payload `{ email, customer_id, jti, bot_id }`. To ingest in an app, add a
   `subscribes` entry for `{ event: "video.viewed", source: "smrtbot" }` in its
   manifest + a handler (the smrtCRM `contact.observed` ingestion is the pattern).
   Until an app subscribes it's simply stored in `app_events` (no side effects).

The playback token now carries `o` (org) and `b` (bot) so the verify endpoint
can attribute the view.

## Planned next (not yet built)

- Optional: have the verify endpoint also return a signed Bunny URL, so the site
  gets "subscriber valid" + the playable URL in one call.
- Native app: register the same `https://<domain>/<num>` as an Android App Link /
  iOS Universal Link → opens in-app when installed, else the page.
