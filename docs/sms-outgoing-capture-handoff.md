# Handoff — capture OUTGOING SMS via a forked SMS Gateway app

**For a fresh Claude Code session scoped to BOTH `smrtesy/mrtesy-app` AND
`smrtesy/android-sms-gateway`.** Read this first, then confirm the plan with
the user before writing code.

## Mission

The SMS integration in `mrtesy-app` already ingests **incoming** SMS/MMS
end-to-end (deployed, working). The remaining task: also capture the messages
the user **sends** from their phone's default messaging app (Samsung Messages).

The open-source SMS Gateway app **cannot** do this as-is — verified in its
source: it has no observer/receiver on the sent box, `sms:sent` fires only for
messages the app itself sends via its API, `GET /messages` returns only the
app's own outbox, and `POST /messages/inbox/export` reads only
`Telephony.Sms.Inbox`. So we must **patch the fork** to observe the sent box and
emit a new webhook event, then build a custom APK.

## What already exists in `mrtesy-app` (do NOT rebuild)

- **Inbound webhook** `src/app/api/webhooks/sms/route.ts` (Vercel, Node runtime).
  - Auth: **secret token in the URL** `?token=<secret>` (constant-time compare
    to the device's Vault secret); HMAC path also supported. The app has no UI
    to share its own signing key, so token-in-URL is what we use.
  - Handles events: `sms:received`, `sms:sent`, `mms:received` (mms:sent is
    "Unsupported event" per the app). Generalized ingest keys threads off the
    conversation **peer** (sender for incoming, recipient for outgoing;
    outgoing `from_phone` = the `"me"` sentinel). OTP suppression is
    incoming-only. `source_url` = `sms:<peer>`.
  - Ingest writes `sms_messages` (raw, idempotent on `user_id,message_id`) and,
    unless OTP/empty, a `source_messages` row (`source_type='sms'`, pending) →
    the `ai-process` edge function classifies it into a task.
- **Server API** `server/src/modules/smrttask/routes/sms.ts`
  (mounted at `/api`): `POST /sms/connect` (generates the token, stores it in
  Vault, returns the tokenized webhook URL), `GET /sms/connections`,
  `POST /sms/disconnect`, `GET /sms/threads`, `GET /sms/messages?peer=`.
- **Reader UI** read-only at `/sms` (`src/components/smrttask/sms/SmsReader.tsx`,
  `SmsPageClient.tsx`), SMS nav item in `Sidebar.tsx`, and `SourceLink.tsx`
  opens the in-app SMS conversation for `sms` sources.
- **DB** migration `supabase/migrations/20260630120000_sms_integration.sql`
  (`sms_messages`, `sms_connections`, serial prefix `M`). Applied to prod.
- **Pipeline** `supabase/functions/ai-process/index.ts` has `"sms"` in
  `SOURCE_PRIORITY` and `BODY_TEXT_FILTER`.
- Sending SMS *from* smrtesy is intentionally **deferred** (local-mode phone is
  unreachable from our cloud).

## The fork patch (`smrtesy/android-sms-gateway`)

Fork of `capcom6/android-sms-gateway` (Kotlin Android app, Koin DI). Package
root `me.capcom.smsgateway`. Mirror the existing MMS observer pattern.

**Reference files (read them first):**
- `app/src/main/java/me/capcom/smsgateway/modules/receiver/MmsContentObserver.kt`
  — the ContentObserver template: registers on `content://mms`, on `onChange`
  queries rows above a high-water-mark, reads each, calls `receiverSvc.process(...)`.
- `.../modules/receiver/ReceiverService.kt` — `process()` stores the message and
  **emits the webhook event** (`SmsReceived`/`MmsReceived`, etc.). Find the exact
  webhook-dispatch service/method it calls.
- `.../modules/receiver/data/InboxMessage.kt` — the message DTO sealed class.
- The webhooks module — where `WebHookEvent` types / event-name constants live
  (full event list: `sms:received`, `sms:data-received`, `mms:received`,
  `sms:sent`, `sms:delivered`, `sms:failed`, `system:ping`, `app:started`).
- `.../modules/settings/Module.kt` — Koin wiring + `StateStorage`
  (high-water-mark storage, e.g. `mmsLastProcessedID`).
- `app/src/main/AndroidManifest.xml` — `READ_SMS` is already declared/granted,
  so **no new permission** is needed to read `content://sms/sent`.

**Changes:**
1. New `SentSmsContentObserver.kt` mirroring `MmsContentObserver`, registered on
   `content://sms/sent`, high-water-mark on `_id` (add e.g.
   `smsSentLastProcessedID` to the state storage). Query columns: `_id`,
   `address` (recipient), `body`, `date`. Dedup via the high-water-mark.
2. New webhook event `sms:sent-observed` (add to the `WebHookEvent` type set /
   event-name registry). Payload: `{ messageId=<provider _id>, message=<body>,
   recipient=<address>, sentAt=<ISO from date> }`. Emit it via the same
   dispatch service `ReceiverService` uses for incoming events.
3. Register the observer in `ReceiverService` start/stop lifecycle + the Koin
   module, alongside `MmsContentObserver`.

**Why `sms:sent-observed` (a NEW event, not `sms:sent`):** the existing
`sms:sent` is a state transition on the app's OWN outbox rows and expects an
internal message id; an observed manual send has no such row.

## GitHub Actions build (so nobody needs Android Studio)

Add `.github/workflows/build-apk.yml` that runs on push and builds an
installable APK, published as a workflow artifact / release asset. `assembleDebug`
gives a self-signed, installable APK with zero secrets — simplest. (A signed
release build needs a keystore in repo secrets.)

**Install caveat:** the fork's APK is signed with a DIFFERENT key than the
user's currently-installed `app-release.apk`, so Android won't update over it —
the user must **uninstall the current app and install the fork build fresh**,
which means **re-doing the device setup** (local server on, permissions, and
re-registering all webhooks — see below).

## `mrtesy-app` change (one line)

In `src/app/api/webhooks/sms/route.ts`, accept the new event as **incoming?no —
outgoing**: add `sms:sent-observed` to the outgoing set so `isOutgoing` is true
for it (it's a message the user sent). Then run the pre-push protocol
(build + server type-check + sub-agent review per `CLAUDE.md`) and push to
`main` (standing authorization; merge `origin/main` first).

## User's device / setup facts

- Phone: **Samsung** (One UI). Incoming arrives as SMS *and* MMS on a US number.
- SMS Gateway **Local server** at `http://10.0.0.8:8080` (verify the IP on the
  app's HOME screen — it changes). Basic auth: user `sms`, password shown on
  HOME (rotates).
- Webhooks are registered via `POST http://<ip>:8080/webhooks` with body
  `{ "url": "<WEBHOOK_URL>", "event": "<event>" }` — **local base has NO
  `/3rdparty/v1` prefix**, endpoints are at root. Register from a PC on the same
  Wi-Fi with the app open in the foreground (its server sleeps in the background).
- Webhook URL: `https://app.smrtesy.com/api/webhooks/sms?token=<TOKEN>`.
  - **Get the TOKEN from the DB** (do NOT hardcode it anywhere): 
    `SELECT public.vault_read_secret(signing_key_id) AS token FROM sms_connections
     ORDER BY connected_at DESC LIMIT 1;` (Supabase project `exjnlghuzuvqedlltztz`).
  - deviceId currently: `ffffffff80692e150000019f1a9e585a`.
- Webhooks already registered: `sms:received`, `sms:sent`, `mms:received`.
  After the fork is installed, also register **`sms:sent-observed`**.
- **Samsung background:** set SMS Gateway to Battery = **Unrestricted** and add it
  to **Never sleeping apps**, or the observer/webhooks won't fire when the screen
  is off. (We saw the local server "disappear" when backgrounded.)

## Constraints / gotchas

- Neither side can compile Android locally → rely on the GitHub Actions build
  logs to fix compile errors in rounds.
- It's a fork the user maintains; re-apply the patch on upstream updates.
- A temporary `sms_webhook_debug` table was used for diagnosis and has been
  **dropped** — recreate it briefly if you need to inspect raw payloads again.

## Suggested first steps for the new session

1. Confirm scope includes both repos; read the reference files above in the fork.
2. Confirm the plan with the user (custom APK, uninstall/reinstall, re-register).
3. Implement the observer + event + Koin wiring; add the CI workflow.
4. Push to the fork; let CI build; fix errors from logs; get an APK artifact.
5. Add `sms:sent-observed` to `mrtesy-app`'s webhook; pre-push protocol; ship.
6. User installs the APK, re-does device setup, registers `sms:sent-observed`,
   sends a test SMS. Verify a row lands in `sms_messages` (direction=outgoing)
   and the `/sms` reader + inbox.
