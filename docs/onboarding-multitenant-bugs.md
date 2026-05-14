# Onboarding & PART 1 — Multi-Tenant Bugs

**Status:** open, blocking new-user signup
**Symptom:** A brand-new user completes onboarding (Google connect, picks 7-day Gmail / 3-month Calendar lookback, selects a Drive folder). The app reports "scan running in the background" and lets the user enter the app, but the Log stays empty forever. No `source_messages`, no `run_session`, nothing.

---

## TL;DR

Two independent failures stack on top of each other:

1. **The scan never starts.** `onboarding/setup/page.tsx` POSTs to `/api/sync/part1` with a raw `fetch()` that omits the `X-Org-Id` header. The backend's `requireOrg` middleware rejects the request with HTTP 400. The page's `catch` block then silently marks `onboarding_completed: true` and shows a "scan is running in the background" toast — lying to the user.
2. **Even if it did start, PART 1 would produce zero rows for any user other than `chanoch`.** The collector and the Drive service contain hardcoded values from the original single-tenant build that were never parameterized.

Fix order: (1) is a 30-line frontend/backend fix. (2) is a small refactor of three files. Both are required to make a new user see anything in the Log.

---

## Bug 1 — Onboarding scan never reaches the server

### Where

- `src/app/[locale]/onboarding/setup/page.tsx:231-238` — uses raw `fetch()`, no `X-Org-Id` header.
- `server/src/routes/sync.ts:34` — `/api/sync/part1` is gated by `[requireAuth, requireOrg, requireApp("smrtesy")]`.
- `server/src/middleware/org-context.ts:18-21` — `requireOrg` returns `400 "X-Org-Id header is required"` when the header is missing.
- `src/app/[locale]/onboarding/setup/page.tsx:264-300` — `catch` block: on any error it reads `user_settings`, sets `onboarding_completed: true`, and shows the false-positive toast.

### Why it regressed

Commit `60872cf` ("feat: complete backend pipeline + frontend wiring") replaced the call to the Supabase `initial-scan` edge function with a direct call to the new Express route, but the Express route is org-gated and the call site never started sending `X-Org-Id`. The user already has an org at this point (created in `onboarding/organization`) and the id is in `localStorage`, so the header is available — just not attached.

### Fix

- Replace the raw `fetch()` in `setup/page.tsx` with the `api()` helper from `src/lib/api/client.ts`. It auto-attaches `Authorization` and `X-Org-Id`.
- Delete the "silent recovery" branch in the `catch` block. If the scan call fails, surface the real error and **do not** mark `onboarding_completed`. Let the user retry or skip explicitly.
- Pass `cal_months` and `drive_folder_id` in the POST body alongside `gmail_days` (currently only `gmail_days` is sent — see next bug).

---

## Bug 2 — PART 1 is hardcoded to chanoch's accounts

### Hardcoded values

| File | Line | Hardcoded value | Effect on a new user |
|---|---|---|---|
| `server/src/parts/part1-collector.ts` | 15 | `GMAIL_ACCOUNTS = ["chanoch@maor.org", "chanoch@kinus.info"]` | Gmail query becomes `deliveredto:chanoch@maor.org` → returns 0 messages for anyone else. |
| `server/src/services/drive.ts` | 4 | `SCANSNAP_FOLDER = "1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1"` | `listNewFiles` scans only this one folder. The `drive_folder_id` the user picks in onboarding is saved to `user_settings` but never reaches this function. |
| `server/src/parts/part1-collector.ts` | 164-165 | `timeMin = now - 3d, timeMax = now + 7d` | The user's `calendar_initial_scan_months` choice (e.g. 3 months) is ignored. |
| `server/src/parts/part2-whatsapp.ts` | 18-19 | `SHEET_ID = process.env.WHATSAPP_SHEET_ID` | Single Sheet id for the whole deployment. The Sheet-ID field on the WhatsApp onboarding page is cosmetic — it isn't persisted or used. (Out of scope for this fix.) |

### Fix

1. **Drive (`services/drive.ts`)**
   - Change signature to `listNewFiles(userId, since, folderId?)`.
   - If `folderId` is missing, look it up from `user_settings.drive_folder_id`.
   - Only fall back to `SCANSNAP_FOLDER` if neither is set (keeps chanoch's existing flow working).

2. **Collector (`parts/part1-collector.ts`)**
   - Replace `GMAIL_ACCOUNTS` with a read from `user_settings.my_emails` (already in the table, already whitelisted in `/me/settings` PATCH). If empty, run the Gmail query without any `deliveredto:` clause — i.e. all incoming mail in the user's inbox.
   - Read `calendar_initial_scan_months` from `user_settings`; use it (months → ms) for `timeMin`. Keep `timeMax` at `now + 7d` (forward lookahead is a product choice, not a per-user setting).
   - Pass `drive_folder_id` from `user_settings` into `listNewFiles`.

3. **Route + client glue (`routes/sync.ts` + `setup/page.tsx`)**
   - Extend the `/api/sync/part1` body to accept `{ gmail_days, cal_months, drive_folder_id }` and forward all three into `runPart1`.
   - Have `setup/page.tsx` send all three in the POST body.

### Why not just read everything from `user_settings`?

We could, but the explicit body keeps the route reusable from the admin Sync page (which lets you re-run a part with overrides) and from cron. The collector should still treat the body values as overrides and fall back to `user_settings` if not provided.

---

## Out-of-scope (flagging for later)

- **WhatsApp Sheet ID per user.** Needs a new column on `user_settings` (or `org_settings`), persistence on the onboarding form, and a `sheet_id` parameter on `runPart2`. Separate ticket.
- **Cron entitlement.** `runScheduledJobs` in `server/src/index.ts` iterates `sync_schedules` and runs `runPart1`/`runPart2` for every enabled user. Once PART 1 is parameterized, every user with an org gets a real first-run on schedule. Verify `sync_schedules` rows are auto-created on org creation, or trigger PART 1 once at the end of onboarding.
- **Drive picker scope.** The onboarding picker uses `corpora=allDrives` but `listNewFiles` doesn't pass `supportsAllDrives=true`. If a user picks a folder on a shared drive, the scan may 404. Worth checking after the parameterization is in.

---

## Verification plan

1. Create a fresh test user with a *different* Gmail account.
2. Walk through onboarding: org → Gmail → Drive (pick a small folder you control) → WhatsApp (skip) → setup (7 days, 3 months).
3. Confirm:
   - Browser network tab shows `POST /api/sync/part1` with `X-Org-Id` header and a 200 response.
   - A row appears in `run_sessions` with `status = 'completed'` or `'partial'` and non-zero `items_processed`.
   - The Log page shows new `source_messages` rows scoped to the test user.
4. Re-run the admin Sync page's manual "Run PART 1" button for the same user — should produce a fresh `run_session` without duplicating sources.
