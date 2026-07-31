# Managed secrets — one place to add a key, live mirror + auto-propagate

**Status:** design / proposal. Not built yet.
**Origin:** the 2026-08-05 WhatsApp/DualHook migration needed one `dh_live_` key
set in **two** places (Railway + Vercel), by hand, each with its own redeploy.
That is the recurring pain this proposes to remove.

## Decisions locked (2026-07-31)

1. **Live mirror + write from the start.** Not a read-only inventory. The
   registry reads the *current* env-var state from each provider's API in real
   time (so you can check at any moment what actually exists in each service),
   **and** can write/propagate a key to every target it belongs to. Write is the
   point — the payoff is "add once, pushed everywhere."
2. **Values stored in Supabase Vault.** The real secret value lives encrypted in
   Vault (`vault_read_secret` RPC — the pattern already used for the WhatsApp
   connection token), read only at sync time. Never plaintext in a DB column,
   API response, or log.
3. **Super-admin only.** The entire feature — viewing the mirror, adding/editing
   a key, and every write/sync — is gated to super-admin (`requireSuperAdmin`).
   No regular user, no per-org role, reaches it.
4. **Layered security is mandatory, not optional** (see "Security model" below).
   Encryption alone is necessary but **not sufficient**.

## The problem

Secrets live in **three** places, each with its own dashboard and redeploy:
Railway env (Express backend, `server/`), Vercel env (Next app, `src/`),
Supabase secrets (edge functions). One logical key often has to be pasted into
2–3 dashboards under the right variable name, and each target redeployed. Miss
one and half the platform breaks silently — the exact footgun the WhatsApp
migration hit.

## Shape

### 1. Data model (new tables)

- `managed_secrets` — `id`, `key_name` (logical name, e.g. "DualHook outbound
  key"), `description`, `vault_secret_id` (value in Vault), `rotated_at`,
  timestamps.
- `managed_secret_targets` — one row per destination: `secret_id`, `provider`
  (`'railway' | 'vercel' | 'supabase'`), `target_ref` (Railway service id /
  Vercel project id / Supabase project ref), `env_var_name` (may differ per
  service), `environment` (`production` / `preview` …), `last_seen_present`
  (from the live read), `value_fingerprint` (a hash for drift comparison — never
  the value), `last_synced_at`, `last_sync_status`, `last_sync_error`.
- `secret_sync_log` — append-only audit of every read/sync/write: who, when,
  which target, result. **Never logs the value.**

### 2. Value storage — Vault

Reuse **Supabase Vault**. Values are read only at sync time, held in memory,
pushed, and dropped.

### 3. Provider connectors (deterministic code, `server/`)

Each connector supports **read** (list current env-var names + presence, for the
live mirror) and **write** (create-or-update a variable), and reports per-target
status. Idempotent; one target failing never blocks the others.

| Provider | Read (mirror) | Write | Redeploy |
|---|---|---|---|
| Railway | GraphQL `variables` query | GraphQL `variableUpsert` | auto-redeploys the service on change |
| Vercel | `GET /v9/projects/{id}/env` (names/metadata) | `POST /v10/projects/{id}/env` / `PATCH …/{envId}` | env change needs a **redeploy** — trigger `POST /v13/deployments` / deploy hook |
| Supabase | Management API list secrets | `POST /v1/projects/{ref}/secrets` | picked up on next invocation / redeploy |

### 4. Live mirror

A super-admin screen that, on load, queries every provider connector's **read**
path and shows the true current state per service: which var names exist, when
each was last updated, and **drift flags** — e.g. *"`WHATSAPP_OUTBOUND_KEY`
present in Railway, MISSING in Vercel"* or *"value differs between Railway and
Vercel"* (compared by `value_fingerprint`, never by revealing the value). This
is the "check at any moment what exists in each service" view.

We display **names + presence + last-updated + fingerprint**, never the secret
value on screen.

### 5. Write / sync engine

`POST /api/admin/secrets/:id/sync` (super-admin): read value from Vault → for
each target call the connector's **write** → trigger redeploys → record status +
audit row. **Every write requires explicit human approval** (a confirm step /
preview of exactly what will change where) so an automated compromise cannot
silently rewrite env vars. Optional post-write verification via the read path.

### 6. Claude's role — propose, never write directly

The in-app Claude console can draft a key's target map ("`dh_live_` key →
Railway `backend` **and** Vercel `production`, var `WHATSAPP_OUTBOUND_KEY`") from
a plain-language ask and **preview** the sync plan. It triggers the sync only
**through the deterministic super-admin endpoint**, which is what performs the
write. Model proposes intent; code performs the write, records the result, fails
closed. (House rule: *"A model may propose; only code may confirm."*)

### 7. UI

`/admin/secrets` (super-admin, compact/collapsed by default): the live mirror
list, each secret showing its targets + presence/drift per provider. Add / edit
/ rotate / "Sync now" (with the approval step). Rotation: new value → Vault →
re-sync all targets → mark `rotated_at`.

## Security model (layered — mandatory)

**Encryption at rest is necessary but not sufficient.** It protects a stolen DB
dump/backup; it does **not** protect the running system, which must decrypt to
work. A breach of the live backend (or its Vault access) can decrypt everything
the app can — and, because this system holds the provider **write** tokens, can
also rewrite env vars everywhere. A central write-capable secrets manager is
therefore the platform's **highest-value target**; it earns defense in depth:

- **Super-admin only**, everywhere (view, edit, sync) — `requireSuperAdmin`.
- **Strong auth (MFA)** on the admin surface.
- **Master provider tokens scoped narrowly** (project-scoped, not account-wide),
  **backend-only** (never exposed to the frontend), and **kept OUT of the
  managed set** — the tool does not manage its own master keys. Availability
  note: the provider dashboards remain a manual fallback, so a broken master
  token is **recoverable by hand** — you are never permanently locked out; this
  is a recovery path, not a reason to skip the "keep them out" rule.
- **Human approval on every write** — no silent env rewrites.
- **Append-only audit log** of every read/sync/write, so a breach is visible.
- **Fast rotation** — rotate every managed key + the master tokens within
  minutes of a suspected breach.

## Caveats to verify before locking

1. **Redeploy latency.** Railway auto-redeploys; Vercel needs a redeploy for env
   to take effect. For a value both runtimes read (like `WHATSAPP_OUTBOUND_KEY`),
   sync pushes all targets, triggers redeploys, and shows "propagating" until
   every target reports the new value live.
2. **Reading values back.** Some provider APIs can return decrypted values; we
   deliberately fetch only names/metadata for the mirror and compare a hash for
   drift — we do not display values.
3. **Provider API drift.** Verify each connector against the live provider API
   schema before locking it (same discipline as verifying fal/Meta contracts
   elsewhere).

## Rollout (incremental, write present from phase 1)

1. **Full loop on Railway.** Tables + Vault storage + Railway connector
   (read **and** write) + the live-mirror screen (Railway column) + the
   approval-gated sync. Ship the complete add→mirror→write→redeploy loop on one
   provider, piloted on the DualHook `WHATSAPP_OUTBOUND_KEY`.
2. **Add Vercel** (read + write + redeploy trigger). Now a single key reaches
   **both** runtimes in one approved click — closes the exact WhatsApp gap.
3. **Add Supabase** (edge-function secrets).
4. **Claude-orchestrated authoring** — console drafts target maps + previews;
   the super-admin endpoint executes.

## First pilot

The DualHook `WHATSAPP_OUTBOUND_KEY` (Railway backend + Vercel production, same
var name) is the phase-1/2 pilot: one key, two targets, already documented in
`docs/whatsapp-dualhook-outbound-migration.md`, and low blast radius because the
consuming code is default-off.
