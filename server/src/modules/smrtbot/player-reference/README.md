# White-label player — integration for the video site (rebbek.org / mymaor.org)

Reference for the team running the external site. The site already has the page
at `https://<domain>/<video_number>`; this adds **gated, white-labelled,
auto-playing** Bunny Stream playback. Two server steps + the bundled
`player.html`.

```
Request:  https://rebbek.org/<video_number>?t=<subscriber-token>

(server-side, on page render)
  1. VERIFY the subscriber token against the platform
  2. if valid → map video_number → Bunny video GUID → SIGN a Bunny directory
     token → inject the signed master.m3u8 URL into player.html
  3. if not valid → show your normal login / subscribe page

(browser) player.html plays it: native HLS (AirPlay) on Safari, hls.js (Cast)
elsewhere. All media from video.<domain>; the verify call is server-side, so
the browser never sees the platform API.
```

## Step 1 — verify the subscriber token (server-side)

```js
// POST to the platform; Bearer = VIDEO_VERIFY_SECRET (shared with the platform).
async function verifySubscriber(t) {
  const r = await fetch("https://<platform-host>/api/smrtbot/playback/verify", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.VIDEO_VERIFY_SECRET}`,
               "Content-Type": "application/json" },
    body: JSON.stringify({ token: t }),
  });
  const j = await r.json();
  // { valid:true, video, email, customer_id, expires_at } | { valid:false, reason? }
  return j;
}
```
`valid:false` (bad/expired token, or `reason:"use_limit_exceeded"` after the
allowed views) → render your login/subscribe page, do NOT sign a stream URL.

## Step 2 — sign a Bunny directory token (server-side, key stays secret)

Map `video` (your number) → the Bunny **video GUID** (kept in the platform's
`smrtbot_videos.bunny_video_guid`, or your own catalog). Then sign a **directory
token** over the video's HLS folder so the manifest AND every `.ts` segment
inherit auth — this is what lets the native player (AirPlay) work without
per-segment JS.

```js
const crypto = require("crypto");

// ⚠️ Bunny has two token formats. Use the one matching your library's
//    "Token Authentication" setting, and confirm the exact byte-format in
//    bunny.net's "URL Token Authentication" docs for YOUR zone before go-live.
//    The V2 PATH-EMBEDDED directory token below is the one that works with
//    native HLS (segments inherit the token from the path). Do NOT enable IP
//    restriction on the token, or casting (different device IP) will 403.
function signBunnyDirectoryUrl(guid, ttlSec = 60 * 60 * 6) {
  const host = process.env.BUNNY_CDN_HOSTNAME;     // e.g. video.rebbek.org
  const key  = process.env.BUNNY_TOKEN_KEY;        // Bunny library Token Auth key
  const dir  = `/${guid}/`;                        // the HLS directory
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const signingData = "";                          // no extra params
  const userIp = "";                               // keep empty (not IP-locked)

  const hmac = crypto.createHmac("sha256", key)
    .update(dir + expires + signingData + userIp)
    .digest("base64");
  const token = "HS256-" + hmac.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Path-embedded form: token params become a path prefix; the real file path
  // follows. token_path is the URL-encoded directory.
  const tp = encodeURIComponent(dir);
  return `https://${host}/bcdn_token=${token}&expires=${expires}&token_path=${tp}${dir}playlist.m3u8`;
}
```

> If your library is configured for the **legacy query-param token** instead,
> the form is `https://host/<path>?token=<base64url(sha256(key+path+expires))>&expires=<exp>&token_path=<dir>`
> — but that requires the player to append the token to each segment via JS,
> which **breaks AirPlay**. Prefer the V2 path-embedded directory token above.

## Step 3 — render the player

Take `player.html` (bundled here), replace `__SIGNED_MASTER_M3U8_URL__` with the
URL from step 2, and serve it (or inject via your template engine).

```js
const html = fs.readFileSync("player.html", "utf8")
  .replace("__SIGNED_MASTER_M3U8_URL__", signBunnyDirectoryUrl(guid));
res.send(html);
```

## Checklist / caveats
- **Self-host hls.js** (`/js/hls.min.js`) for full white-label — otherwise it's a CDN request.
- **Autoplay**: browsers block unmuted autoplay without a gesture; `player.html` falls back to a one-tap overlay (keeps sound) rather than muting.
- **Chromecast** loads the Google Cast SDK from `gstatic.com` (the one unavoidable external script). Remove that `<script>` to stay 100% on your domain (AirPlay still works).
- **Token not IP-locked** (see step 2) — required for casting.
- **allowed domains** for the library must include your front domain(s): `rebbek.org`, `mymaor.org`.
- **Final test**: open DevTools → Network → confirm every media request is `video.<domain>` only; then test AirPlay + Chromecast.

## Env on the site
| var | value |
|---|---|
| `VIDEO_VERIFY_SECRET` | shared secret with the platform (same as platform's app_secrets) |
| platform verify URL | `https://<platform-host>/api/smrtbot/playback/verify` |
| `BUNNY_CDN_HOSTNAME` | `video.rebbek.org` (per domain) |
| `BUNNY_TOKEN_KEY` | the Bunny library's Token Authentication key |
