# Deploy queue — coalescing backend deploys so console runs stop killing each other

> Status: **design, awaiting approval**. Author: Claude console session, 2026-08-04.
> Owner decision points are marked **[decision]**.

## The problem

The Claude console runner lives inside the **Railway backend process**. Railway
auto-deploys the backend on every push to `main`, and a deploy sends `SIGTERM`
(exit 143) to the container — which kills **every in-flight console run at once**.

When the user works on several fixes in parallel (the normal workflow), each fix
pushes to `main` in its turn, and every one of those pushes restarts the backend
and knocks down all the *other* running fixes. Hard evidence (Railway deployment
history, 2026-08-04): deploys landed 3–14 minutes apart in bursts
(`08:08 → 08:15 → 08:23 → 08:28 → 08:36 → 08:39 → 08:53`), and console runs gave
up in the same windows — different threads dying at the *same second*, the
signature of a shared cause (a restart), not a per-run crash.

## What is already done (do not redo)

1. **`watchPatterns = server/**` on the Railway service** (enabled by the user,
   2026-08-04). The backend now redeploys **only** when a push changes
   `server/**`. Frontend (`src/**`), docs, and plan pushes no longer restart it.
   This removed the majority of the restarts on its own.
2. **Run-recovery tolerates restarts** (merged `main`, commit `e013d212`):
   `MAX_RESUME_ATTEMPTS` raised to 3, and a *restart-orphan* (a run killed by the
   deploy that started the current process — last heartbeat predates
   `PROCESS_BOOT_MS`) does **not** consume the attempt budget. So a run killed by
   a deploy now resumes itself instead of giving up. See
   `server/src/modules/claude/recover.ts`.

Because of #2, a deploy is **no longer catastrophic** — interrupted runs recover.
That reframes this feature: the queue's job is to **reduce how often** the backend
restarts (coalesce many server deploys into one), NOT to guarantee zero
interruptions. This is why the design deliberately drops the intrusive parts the
user and I discussed and rejected (blocking the user from editing; waiting for
"no session active").

## Goals / non-goals

**Goals**
- Collapse N near-simultaneous server deploys into **one** deploy of the whole batch.
- Deploy the batch at a settled moment, or within a **30-minute** cap regardless.
- Zero added friction to the user's actual work — the coding loop is not slowed.

**Non-goals**
- Do **not** block the user from working or editing during a pending deploy.
- Do **not** wait on non-server work (conversations, frontend, docs) — none of it
  restarts the backend.
- Do **not** try to perfectly time deploys to zero active runs (recovery covers the
  interruption).

## The model (settled with the user)

### 1. Only `server/**` changes are queued; everything else pushes immediately

The single fact that decides whether a push restarts the backend is **whether its
diff touches `server/**`** — the exact same rule as the watch path. So that is the
queue's membership rule too:

| The branch's diff vs `origin/main` | What happens |
|---|---|
| touches `server/**` | routed into the **deploy queue** (coalesced) — this is what restarts the backend |
| touches only `src/**`, `docs/**`, … | **pushed to `main` immediately**, no queue — it will not restart the backend |

Deterministic check, no guessing: `git diff --name-only origin/main...HEAD` — any
line under `server/` ⇒ server change.

### 2. Two-state queue entries: `building` → `ready`

A server fix is registered as early as possible, so the coordinator holds the
deploy for fixes that are still in flight (not only ones already finished — the
gap the user caught).

| State | Set when | Effect on the deploy |
|---|---|---|
| `building` | the run first changes a file under `server/` (see detection below) | the coordinator will **not** fire a deploy while any `building` row exists — a fix is still coming |
| `ready` | the run built + tested + pushed its **branch**, and would otherwise have pushed to `main` | joins the batch |

The deploy fires only when **every** row is `ready` (none `building`) **and** the
batch has settled (§4).

### 3. Detection — max-speed (the user's choice)

The early `building` signal comes from a **hook the engine runs automatically**
(same reliability model as the existing `map-guard` / `cost-guard` hooks — not
dependent on the model remembering).

- **Fast path (Edit/Write):** a `PostToolUse` hook matched to `Edit|Write` reads
  the tool's `file_path`. If it is under `server/` **and** a local marker
  (`.claude/tmp/deploy-building-<thread>.marker`) does not yet exist → fire a
  **fire-and-forget** `register-building` POST and drop the marker. Cost: a string
  check, sub-millisecond. Once the marker exists every later call **short-circuits**
  immediately. No `git`, no per-call DB write.
- **No bash-diff in the loop.** Side-channel edits (`sed`, `git apply`, codegen)
  are **not** chased on every Bash call (that was the max-accuracy option we
  dropped). They are caught by the push-time gate instead (below), so nothing is
  ever *missed* — the fast hook only affects how early coalescing sees the fix, and
  **correctness does not depend on it**.

### 4. When the batch deploys

Fire the batched deploy when **both** hold:
- **all** queue rows are `ready` (no `building`), and
- the batch has **settled**: no server change entered/updated the queue in the last
  **~3 minutes** (the user's wave has stopped),

**or** the **30-minute cap** from the earliest still-queued row has elapsed —
whichever comes first. A steady trickle of fixes therefore still ships within 30
minutes of the first one.

### 5. The clock

A compact widget in the console shows the queue: the pending server fixes
(count + titles), each row's state, and a live **countdown** — `פורס בעוד M:SS
(או כשהצרור יתייצב)` — visible even while quiet has not arrived. Compact-by-default
per the UI rule: one quiet entry point, not a permanent toolbar.

## Where the pieces live

### DB — `claude_deploy_queue` (org-scoped, like the other `claude_*` tables)

| column | notes |
|---|---|
| `id` uuid pk | |
| `org_id` | scope |
| `thread_id` | one active fix per thread — upsert key |
| `run_id` | the run that registered (for staleness via its heartbeat) |
| `branch` | the feature branch to merge into the batch |
| `title` | short label for the clock UI |
| `state` | CHECK in (`building`,`ready`,`deploying`,`done`,`failed`,`conflict`) |
| `created_at`,`updated_at` | `created_at` of the earliest row drives the 30-min cap |

Additive migration (`CREATE TABLE` + index) — applied by the implementing session
per the migration-discipline rule.

### Endpoints — machine-to-machine, `x-cron-secret` gated (like `/claude-session`)

- `POST /claude-deploy/register-building` `{ org_id, thread_id, run_id, branch, title }`
  → upsert row `state='building'`. Called by the detection hook (fire-and-forget).
- `POST /claude-deploy/mark-ready` `{ thread_id, branch }` → `state='ready'`. Called
  by the run at push time instead of pushing server changes to `main` itself.
- (internal) the coordinator transitions `ready → deploying → done|failed|conflict`.

### Push-time gate (enforcement + the fallback that never misses)

The real enforcement is at the moment a run would push to `main`. A pre-push step
(hook or the merge routine) runs the deterministic `git diff --name-only
origin/main...HEAD` **once**:
- no `server/` line → push to `main` directly (immediate; watch path ⇒ no restart);
- a `server/` line → do **not** push to `main`; push the **branch**, call
  `mark-ready`, and stop. This is also where a side-channel `building`-miss is
  caught, so coalescing correctness is guaranteed here regardless of the fast hook.

### Coordinator — a server background loop (NOT a console run)

Runs like `recover.ts` (a `setInterval`, off the request path), so it never counts
itself as activity and is never a run that a deploy could kill mid-decision. Each
tick, per org with queue rows:
1. Drop stale `building` rows whose `run_id` has no fresh heartbeat (the fix was
   abandoned / its thread died) — so a dead fix can't block the queue forever.
2. If any `building` row remains → wait, unless the 30-min cap passed → force.
3. If all `ready` and settled (or cap) → **fire the deploy** (below).

### Deploy-run — the hands that do the git

The coordinator does not push (the backend process is not a working checkout with
push creds). When it fires, it **spawns a dedicated deploy-run** (a console run on
an automation thread, which already has a workspace + `git` + `GITHUB_TOKEN`) whose
job is fixed: `git fetch`, merge every `ready` branch onto `main` **sequentially**,
run the pre-push **build once** on the merged result, `git push origin main`, then
mark the rows `done`. It is excluded from the queue (it edits nothing under
`server/`). It is killed by its own resulting deploy — but push is its **last**
act, so that is harmless, and recovery covers it if the push itself is interrupted.

**[decision]** deploy-run vs. granting one ready run a "deploy token" to merge +
push the batch. Recommended: the dedicated deploy-run — the deciding brain
(background loop) and the git hands (a run) stay cleanly separated, less new
coordination code.

## Conflicts & failures (surface, never auto-resolve)

- **Merge conflict** between two `ready` branches → skip the conflicting branch,
  mark it `conflict`, **notify the user** to resolve it, and deploy the rest of the
  batch. (Per "A model may propose; only code may confirm" — we do not
  silent-resolve a merge.)
- **Batched build fails** → do not push; mark the batch `failed` and notify with
  the build output. The integration failure is exactly the thing a single batched
  build is there to catch before it reaches production.
- The 30-min cap is measured from the **earliest** queued row, so nothing waits
  longer than 30 minutes.

## Why this doesn't slow the built-in Claude

- The queue/coordinator are **background**; the run's coding loop is unchanged. The
  only thing deferred is the push-to-main, which is already asynchronous — the user
  never waits on it.
- The only in-loop cost is the fast detection hook: a sub-millisecond path-prefix
  check that short-circuits after the first server edit, plus one fire-and-forget
  POST per session. Same class as the hooks already running today.

## Phasing

1. **Migration + endpoints + queue table** (additive, invisible).
2. **Push-time gate** — route `server/**` branches to `mark-ready` instead of
   pushing to `main`. (This alone already serializes; correctness lands here.)
3. **Coordinator loop + deploy-run** — the coalescing + batched deploy.
4. **Detection hook** — the early `building` signal (pure timing improvement).
5. **Clock UI** — the countdown widget.

Each phase is shippable and safe on its own; 1–2 give serialized correctness before
the coalescing brain (3) exists.

## Open questions for the owner

- **[decision]** deploy-run vs. deploy-token (recommended: deploy-run).
- **[decision]** settle window default **3 min** — good, or shorter/longer?
- **[decision]** the clock's home: a small panel on `/claude`, or fold into the
  existing `ClaudeActivityBar` on `/tasks`?
- Should a **failed batched build** try to bisect which branch broke it, or just
  fail the batch and let the user look? (Recommended: fail + surface first; bisect
  later if it proves annoying.)
