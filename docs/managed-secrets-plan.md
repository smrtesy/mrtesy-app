# Managed secrets — one place to add a key, auto-propagated to every service

**Status:** design / proposal. Not built yet.
**Origin:** the 2026-08-05 WhatsApp/DualHook migration needed one `dh_live_` key
set in **two** places (Railway + Vercel), by hand, each with its own redeploy.
That is the recurring pain this proposes to remove.

## The problem

Secrets live in **three** places today, each with its own dashboard and its own
redeploy:

- **Railway** env — the Express backend (`server/`).
- **Vercel** env — the Next app (`src/`).
- **Supabase** secrets — edge functions (`supabase/functions/`).

So one logical key (a provider token, a `dh_live_` key, an API secret) often has
to be pasted into 2–3 dashboards, under the right variable name, and each target
redeployed. Miss one and half the platform breaks silently — exactly the
footgun the WhatsApp migration walked into (the key is needed in both runtimes).

## The idea

**Add a key once, in our own admin UI. A deterministic engine pushes it to every
service that needs it and triggers the redeploys.** The user (or the in-app
Claude console) declares *what the key is* and *where it belongs*; code does the
writing.

This extends the existing `app_secrets` pattern (DB-stored runtime secrets,
edited at `/admin/apps/<slug>/secrets`) from "one runtime reads it from the DB"
to "propagate it into the hosting providers' own env stores," which is what a
value like `WHATSAPP_OUTBOUND_KEY` — read by `process.env` at boot in two
separately-deployed runtimes — actually needs.

## Shape

### 1. Data model (new tables)

- `managed_secrets` — `id`, `key_name` (logical name, e.g. "DualHook outbound
  key"), `description`, `vault_secret_id` (the value lives in **Supabase Vault**,
  never plaintext in a column), `rotated_at`, timestamps.
- `managed_secret_targets` — one row per destination:
  `secret_id`, `provider` (`'railway' | 'vercel' | 'supabase'`),
  `target_ref` (Railway service id / Vercel project id / Supabase project ref),
  `env_var_name` (the name in that service — they can differ),
  `environment` (`production` / `preview` …), `last_synced_at`,
  `last_sync_status` (`ok | error | pending`), `last_sync_error`.
- `secret_sync_log` — append-only audit: who synced what, when, result. **Never
  logs the value.**

### 2. Value storage

Reuse **Supabase Vault** (`vault_read_secret` RPC — already used for the
WhatsApp connection token). Values are read only at sync time, held in memory,
pushed, and dropped. No plaintext in DB rows, responses, or logs.

### 3. Provider connectors (deterministic code, `server/`)

| Provider | Write | Redeploy |
|---|---|---|
| Railway | GraphQL `variableUpsert` (projectId, environmentId, serviceId, name, value) | Railway auto-redeploys the service on a variable change |
| Vercel | `POST /v10/projects/{id}/env` (create) / `PATCH /v9/projects/{id}/env/{envId}` (update) | env changes need a **redeploy** to take effect — trigger `POST /v13/deployments` (or a deploy hook) |
| Supabase | Management API `POST /v1/projects/{ref}/secrets` (edge-function secrets) | picked up on next function invocation / redeploy |

Each connector is idempotent (create-or-update) and reports per-target status.
One target failing must not block the others.

### 4. Propagation engine

`POST /api/admin/secrets/:id/sync` (super-admin only): read value from Vault →
for each target, call its connector → record status + audit row → return a
per-target result. A "Sync now" button and an optional post-write verification
(read the env back where the provider API allows it).

### 5. The bootstrap secret (important)

The engine itself needs **provider admin tokens** — `RAILWAY_TOKEN`,
`VERCEL_TOKEN` (+ team id), `SUPABASE_ACCESS_TOKEN`. These are the keys to the
kingdom: whoever holds them can rewrite every env var. They must:

- live **only** in the Railway backend env (NOT managed by this system — avoid
  the circular dependency of the tool managing its own master keys);
- be **scoped** as narrowly as each provider allows (project-scoped, not
  account-wide, where possible);
- be **rotatable**, with the audit log making blast radius visible.

This is the one real security tradeoff: centralizing propagation concentrates
power. The mitigation is scope + audit + super-admin-only + the master tokens
staying out of the managed set.

### 6. Claude's role — propose, never write

The in-app Claude console can:
- draft a key's **target map** ("`dh_live_` key → Railway `backend` **and**
  Vercel `production`, var `WHATSAPP_OUTBOUND_KEY`") from a plain-language ask;
- **preview** the sync plan for the user to approve;
- trigger the sync **through the deterministic endpoint**.

It must **never** write a provider env directly. This is the house rule from
`CLAUDE.md` — *"A model may propose; only code may confirm."* The model decides
intent and mapping (semantics); the connector code performs the write (facts),
records the result, and fails closed on error.

### 7. UI

`/admin/secrets` (super-admin): a compact list of managed secrets, each showing
its targets + last-sync status (green/amber/red per provider). Add / edit /
rotate / "Sync now". Follows the compact-UI rule — collapsed by default, details
on expand. Rotation flow: new value → Vault → re-sync all targets → mark
`rotated_at`.

## Caveats to decide up front

1. **Redeploy latency.** Vercel needs a redeploy for env to take effect; there's
   a short window where Railway has the new value and Vercel doesn't (or vice
   versa). For a value both runtimes read (like `WHATSAPP_OUTBOUND_KEY`), sync
   should push **all** targets, then trigger redeploys, and surface "propagating"
   until every target reports the new value live.
2. **Store-the-value vs orchestrate-only.** Holding the real value in our Vault
   centralizes risk. Alternative: store only the target map and have the user
   paste the value at sync time (we never persist it). Tradeoff: convenience &
   rotation vs. blast radius. Recommend Vault-stored with strict access; revisit
   if the risk profile changes.
3. **Provider API drift.** Vercel/Railway/Supabase API shapes change — verify
   each connector against the live API schema before locking it (same discipline
   as verifying fal/Meta contracts elsewhere in the platform).

## Rollout (incremental, each phase useful alone)

1. **Registry (read-only).** `managed_secrets` + `managed_secret_targets`, a UI
   that just **documents** where each key lives today. Zero write risk; already
   removes "which dashboards is this key in?" confusion.
2. **Railway connector + sync.** One provider, `variableUpsert`, auto-redeploy.
   Pilot on a low-risk var.
3. **Vercel connector + redeploy trigger.** Now a single key reaches both
   runtimes in one click — the WhatsApp `dh_live_` key is the first real target.
4. **Supabase connector.** Edge-function secrets.
5. **Claude-orchestrated authoring.** Console drafts target maps + previews;
   deterministic endpoint executes.

## First pilot

The DualHook `WHATSAPP_OUTBOUND_KEY` (Railway backend + Vercel production, same
var name) is the ideal phase-2/3 pilot: one key, two targets, already
documented in `docs/whatsapp-dualhook-outbound-migration.md`, and low blast
radius because the consuming code is default-off.
