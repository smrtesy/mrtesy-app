# Handoff — send MMS attachments from the SMS Gateway fork

**For a session scoped to BOTH `smrtesy/mrtesy-app` AND
`smrtesy/android-sms-gateway`.** The `mrtesy-app` half is **already built and
deployed** (2026-07-28). What remains is the Android half. Read the
"Contract" section before writing a line of Kotlin — the app side is finished
and waiting for exactly that payload shape.

Companion doc: `docs/sms-outgoing-capture-handoff.md`, which describes the same
fork and the `sms:sent-observed` / `mms:sent-observed` events already shipped.

## Mission

Make SMS/MMS transcribe voice and OCR images **exactly like WhatsApp**. Today
it does neither, and the reason is not the AI side — it is that the bytes never
arrive.

### Why the app side alone cannot fix this

Verified 2026-07-28, twice, before writing any code:

1. **Upstream docs** (`docs.sms-gate.app/features/webhooks/`) — nine events.
   `mms:received` carries `messageId`, `transactionId`, `subject`, `size`,
   `contentClass`, `sender`, `recipient`, `simNumber`, `receivedAt`. Metadata
   only. No base64, no URL, no parts.
2. **Production data** — every distinct key across all 287 archived
   `sms_messages.raw_payload` rows: `recipient`, `messageId`, `message`,
   `phoneNumber`, `simNumber`, `sentAt`, `sender`, `receivedAt`. Nothing else
   has ever arrived.

The gateway runs in **local mode** on the user's phone, unreachable from
Vercel, so we cannot pull the bytes either. They have to be pushed, by the
fork, in the webhook body.

### What that costs today

`sms_webhook_debug`, first three weeks of the integration:

| event | outcome | n |
|---|---|---|
| `mms:sent-observed` | ingested | 113 |
| `mms:sent-observed` | **`empty_body`** | **16** |
| `sms:received` | ingested | 67 |
| `sms:received` | otp_suppressed | 40 |
| `mms:sent-observed` | self_note | 12 |
| `sms:sent-observed` | ingested | 14 |

The 16 `empty_body` rows are attachment-only MMS — a photo with no caption.
They reach `sms_messages` and then stop: no body, nothing to classify, no task.

Also note what is **missing** from that table: not one `mms:received` or
`mms:downloaded` event in three weeks, while 113 `mms:sent-observed` arrived
over the same window. So the phone is emitting MMS events for the sent box and
none for the inbox. Two candidate causes, in likelihood order — check the first
before writing code: (1) the `mms:downloaded` webhook was never registered on
the device (the earlier handoff lists only `sms:received`, `sms:sent` and
`mms:received` as registered, and a reinstall drops registrations anyway);
(2) the observer isn't firing. Whichever it is, incoming MMS is invisible
end-to-end today. See "Device setup" below.

## Contract — the payload `mrtesy-app` already accepts

Add an `attachments` array to the payload of `mms:downloaded` and
`mms:sent-observed`. Everything else in the payload stays exactly as it is.

```json
{
  "deviceId": "ffffffff80692e150000019f1a9e585a",
  "event": "mms:downloaded",
  "payload": {
    "messageId": "12345",
    "body": "optional caption text",
    "sender": "+13475848008",
    "recipient": "+19293330248",
    "receivedAt": "2026-07-28T14:03:11.000-04:00",
    "attachments": [
      {
        "contentType": "image/jpeg",
        "filename": "IMG_0421.jpg",
        "data": "<base64 of the raw bytes>"
      }
    ]
  }
}
```

Field rules, as implemented in `src/app/api/webhooks/sms/route.ts`
(`normalizeAttachments`):

- `contentType` — the part's MIME type from `content://mms/part.ct`.
  Aliases accepted: `mimeType`, `type`.
- `data` — base64 of the part's bytes. Aliases accepted: `base64`, `content`.
  A part with no bytes is **dropped**, so never send a metadata-only entry.
- `filename` — the part's `cl`/`name` column, or anything readable. Alias:
  `name`. Optional; falls back to `part<i>`.
- The array key may be `attachments` or `parts`. Either is read.

**Skipped on our side, so don't bother sending them:** the `application/smil`
layout part every MMS carries, and `text/*` parts — their content is already
the message body.

### Hard constraints

- **Total request body ≤ 4 MB.** Vercel's serverless function body limit is
  4.5 MB and base64 inflates by ~33%, so keep the sum of raw part bytes under
  ~3 MB. Carrier MMS is capped around 1 MB, so this is headroom, not a
  squeeze — but if a part would blow the budget, send it with `data` omitted
  rather than truncated. A truncated base64 decodes to garbage that would be
  stored and OCR'd as a real file.
- **Send the same `messageId`** the event already uses. The app side keys its
  redelivery guard on it: a redelivered MMS whose stored row already has
  analysed media is reused, not re-analysed. Without a stable id every retry
  is another paid Gemini call.
- **`mms:downloaded`, not `mms:received`.** `mms:received` is the pre-download
  WAP-push header, has no body and no parts, and only fires for the default SMS
  app. The app side already namespaces `mms:downloaded` ids as `mmsdl:<id>` to
  keep them from colliding with `content://sms` ids.

## The fork patch (`smrtesy/android-sms-gateway`)

The fork already has an MMS observer reading `content://mms` — that is what
emits `mms:sent-observed` today. The patch extends it to read the message's
parts.

**Reference files:**
- `app/src/main/java/me/capcom/smsgateway/modules/receiver/MmsContentObserver.kt`
  — already queries `content://mms` rows and calls into `ReceiverService`.
- `.../modules/receiver/ReceiverService.kt` — where the webhook event is built
  and dispatched.
- `.../modules/receiver/data/InboxMessage.kt` — the DTO to extend.

**Changes:**

1. Query the parts for a given MMS `_id`:
   `content://mms/part` with selection `mid = ?`, columns `_id`, `ct`
   (content type), `cl` / `name` (filename), `_data`, `text`.
2. Read each part's bytes via
   `contentResolver.openInputStream(Uri.parse("content://mms/part/" + partId))`
   — **not** `File(_data)`; the `_data` path is not world-readable and the
   resolver is the supported route.
3. Skip parts whose `ct` is `application/smil` or starts with `text/`.
4. Base64-encode with `Base64.encodeToString(bytes, Base64.NO_WRAP)` —
   `NO_WRAP` matters, the default inserts newlines.
5. Add `attachments: List<Attachment>` to the MMS DTO and serialize it into the
   webhook payload for both `mms:downloaded` and `mms:sent-observed`.
6. Enforce the 3 MB budget in Kotlin: accumulate raw sizes, and for a part that
   would exceed it emit the entry with `data = null`.

**Permissions:** `READ_SMS` already covers `content://mms/part`. No manifest
change.

**Build:** the existing `.github/workflows/build-apk.yml` produces the
installable artifact. Same install caveat as before — a different signing key
means uninstall-then-install, which means redoing device setup.

## Device setup after the APK is installed

Webhooks are registered against the phone's local server. The app must be
**open in the foreground** and the PC on the same Wi-Fi.

1. Open the SMS Gateway app; read the local server IP and the basic-auth
   password from its HOME screen (both rotate — read them, don't reuse old
   values).
2. Get the webhook token from the database — never hardcode it:
   ```sql
   SELECT public.vault_read_secret(signing_key_id) AS token
   FROM sms_connections ORDER BY connected_at DESC LIMIT 1;
   ```
   (Supabase project `exjnlghuzuvqedlltztz`.)
3. Register each event against
   `https://app.smrtesy.com/api/webhooks/sms?token=<TOKEN>`:
   ```
   POST http://<ip>:8080/webhooks
   { "url": "<WEBHOOK_URL>", "event": "<event>" }
   ```
   Events needed: `sms:received`, `sms:sent-observed`, `mms:sent-observed`,
   and — **currently missing, which is why no incoming MMS has ever
   arrived** — `mms:downloaded`.
4. Samsung: Battery = **Unrestricted** and add the app to **Never sleeping
   apps**, or the observers stop when the screen is off.

## Verifying it worked

Send yourself an MMS with a photo of some text, then:

```sql
SELECT message_id, body_text, jsonb_array_length(media_parts) AS parts
FROM sms_messages
WHERE media_parts IS NOT NULL
ORDER BY received_at DESC LIMIT 5;
```

`body_text` should contain an `[OCR]` block with the text from the photo, and
the same message should appear at `/sms` with the picture rendered in the
bubble. A row with `media_parts` but a bracketed placeholder body means the
bytes arrived and Gemini failed — check `ai_usage` for a `gemini.sms` row and
the Vercel function log.
