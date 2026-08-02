# Drive Catalog — full, resumable inventory of a shared Drive subtree

**Goal.** Catalog every folder and file under a chosen (shared) Google Drive
folder into a searchable, actionable index — without paid API tokens and
resumable across interruptions.

## Why server-side (not the chat connector)

The built-in Claude *can* read Drive via the claude.ai Google Drive connector,
but every file would pass through the chat: slow, token-heavy, and — critically
— the connector does **not** exist in unattended/cron runs, so an
auto-resume-after-token-limit could not keep walking. The user's `google_drive`
OAuth is **also** connected server-side (`user_credentials`), so the scan runs
on the Express backend instead: thousands of files, zero agent tokens, and true
unattended resume.

## Data model (`supabase/migrations/20260802170000_drive_catalog.sql`)

- **`drive_catalog`** — one row per node under a `root_folder_id`
  (folder OR file): `file_id`, `parent_id`, `title`, `mime_type`, `is_folder`,
  `kind` (folder/document/spreadsheet/pdf/image/video/audio/…), `path`,
  `depth`, `owner`, `file_size`, `modified_time`, `view_url` (verbatim Drive
  deep link). Resume flag **`folder_expanded`** marks folders whose children
  were already listed. Phase-2 columns (`summary`, `tags`, `decisions`,
  `content_indexed`) are ready for content enrichment. Unique on
  `(root_folder_id, file_id)`; RLS on, owner-select policy.
- **`drive_catalog_scans`** — per-root state: `status`
  (`inventory` → `inventory_done` → `enriching` → `done`), timestamps.

## The scanner (`server/src/modules/smrttask/routes/drive-catalog.ts`)

Machine endpoints, `x-cron-secret` gated (mounted before the auth guards):

- **`POST /api/drive-catalog/scan`** `{ user_id, root_folder_id, max_seconds?, iteration? }`
  — one time-boxed pass of a **DB-backed BFS**: pull a batch of the shallowest
  `folder_expanded=false` folders, list each folder's direct children via the
  Drive API (paginated, `supportsAllDrives`), upsert a row per child
  (`ON CONFLICT DO NOTHING` so nothing already scanned is clobbered), then flip
  the parent to `folder_expanded=true`. When the frontier empties → status
  `inventory_done`. If work remains it **self-kicks** (fire-and-forget re-POST)
  so the whole tree drains on the server; `MAX_ITERATIONS` is the runaway guard.
- **`GET /api/drive-catalog/status?root_folder_id=…`** — scan state + counts
  (nodes / folders / files / folders pending expansion).

Resumability is entirely in the DB: a pass that dies mid-walk leaves every
finished folder marked expanded, so the next call (self-kick, a manual re-POST,
or a cron backstop) continues from exactly where it stopped — no re-listing.

## Phases

1. **Inventory (this build).** Full metadata index of every node. Fast, no
   content reads.
2. **Content enrichment (next).** For text-bearing docs (Docs/Sheets/PDF/Word):
   summary + tags + surfaced decisions into the phase-2 columns. Media stays
   metadata-only.
3. **Actions (later).** Search UI in smrtesy over `drive_catalog`, and
   per-file actions.

## First run

Root `Maor NEW` (`1Twsa2liwkIHo6hMO2102ZaL09__aVUBM`), shared with the platform
user `9cb6086a-2deb-44c1-93b6-93408f4d273c`. Kicked once from the operating
session; the server self-drains the rest.
