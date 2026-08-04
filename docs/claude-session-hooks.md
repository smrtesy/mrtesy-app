# Claude session hooks — archived 2026-08-04

> These two sections were **removed from `CLAUDE.md`** on 2026-08-04 to cut
> always-loaded tokens (~2,850 tokens/session). Kept here for reference.
>
> - **session-proposal**: was already DISABLED (not in `settings.json`). The
>   scripts remain in `.claude/hooks/`; re-enable per the notes below.
> - **long-task auto-resume**: was OUTDATED — it calls `create_trigger` /
>   `delete_trigger`, which in the current environment are `RemoteTrigger`
>   (create/update/run) and `CronCreate`. Its Stop hook `longtask-guard.sh`
>   was removed from `settings.json` and its scripts deleted. To revive it,
>   rewrite against `RemoteTrigger`/`CronCreate` first.

---

## smrtTask session proposals (Stop hook)

> **DISABLED as of 2026-08-04 (user experiment).** The `Stop` hook entry for
> `.claude/hooks/smrttask-session-proposal.sh` was **removed from
> `.claude/settings.json`** at the user's request, to test whether dropping the
> per-turn summary block makes long console chats feel faster. Consequence
> while disabled: console sessions no longer file/refresh a smrtTask "הצעה", and
> there is no safety-net trace either. The hook **scripts are kept in the repo
> unchanged** — re-enabling is one entry back under `hooks.Stop` in
> `settings.json` (put it before `longtask-guard.sh`). Do **not** re-add it
> unless the user asks. Everything below documents the mechanism as it works
> **when enabled**, for that re-enable.

**Requirement:** every Claude Code chat in this repo must leave a trace in
smrtTask. When a chat here stops, a "הצעה" (proposal) is filed into the
user's smrtTask inbox summarizing the session: the topic discussed, where it
happened (repo / branch), a verbatim deep link back to the web chat, and a
proposed next step to close the discussion/action.

This is enforced by a **`Stop` hook**, not by Claude remembering to do it —
the harness runs the hook on every turn-end, so it fires reliably even if the
session ends abruptly. Claude following a CLAUDE.md line alone would be
best-effort; the hook is the real mechanism. Moving parts:

- **`.claude/settings.json`** → `hooks.Stop` runs
  `.claude/hooks/smrttask-session-proposal.sh`.
- **`.claude/hooks/smrttask-session-proposal.sh`** — the enforcer. Two free
  mechanisms (no paid API tokens):
  1. **Enforce the agent summary.** On the FIRST stop of a turn-cycle it emits
     `{"decision":"block","reason":…}`, which the harness feeds back to the
     agent as its next instruction: write a short Hebrew summary and run
     `.claude/hooks/post-session-summary.sh`. The harness sets
     `stop_hook_active=true` when it re-runs the hook after the agent
     continued — that's the loop-guard, so it blocks **at most once** per
     turn-cycle. This is what makes the summary reliable instead of
     best-effort — a plain CLAUDE.md line was NOT firing (2026-07: proposals
     were landing as the minimal placeholder because the agent never posted).
  2. **Safety net.** On the second stop it fire-and-forgets a minimal metadata
     trace (via `build-session-proposal.mjs`), detached so it never delays a
     turn. So even a session where the agent failed to post still leaves a row.
  Fully guarded: not a web session (`CLAUDE_CODE_REMOTE_SESSION_ID` unset),
  or a missing secret / URL / `node`/`curl`/`jq`, makes it a no-op that
  neither blocks nor fails a turn.
- **`.claude/hooks/post-session-summary.sh`** — the helper the agent runs when
  blocked. Takes `"<topic>" "<summary>" "<next_step>"` (or `--json <file>`),
  resolves session/secret/URL/identity exactly like the Stop hook, builds the
  body with `jq --arg` (safe escaping), and POSTs `{ topic, summary, next_step }`
  (plus the Claude-account identity `{ claude_user_email, claude_user_name }`)
  so the backend enriches the SAME task. Prints the endpoint response so the
  agent can confirm `"ok":true`. The summary is written by the agent on the
  user's Claude subscription — ZERO paid API tokens.
- **`.claude/hooks/build-session-proposal.mjs`** — builds the minimal safety-net
  body. Derives everything from the environment: `session_id`/`session_url` from
  `CLAUDE_CODE_REMOTE_SESSION_ID` (`cse_<slug>` →
  `https://claude.ai/code/session_<slug>`), `user_email` from
  `CLAUDE_CODE_USER_EMAIL`, the Claude-account identity
  `claude_user_email`/`claude_user_name` (also from `CLAUDE_CODE_USER_EMAIL`;
  name = local-part before `@`, kept separate from the resolution `user_email`
  which a `SMRTTASK_USER_EMAIL` override may replace), `git_branch` from
  `.git/HEAD`, and a compact transcript from `transcript_path` (metadata only
  — NO topic/summary).
- **`POST /api/claude-session/proposal`** (server
  `modules/smrttask/routes/claude-session.ts`) — machine-to-machine, gated by
  the shared `x-cron-secret` header (same pattern as `/sync/run-scheduled`, no
  JWT). Resolves the user → primary org → smrttask entitlement and **upserts one
  task per session** keyed by the tag
  `claude-session:<session_id>` (`task_type: "followup"`, `status: "inbox"`,
  `priority: "low"`, `manually_verified: false`, the deep link in
  `action_links`). The proposal `description` also carries a `חשבון Claude:`
  line — the Claude-account identity (`claude_user_name` + `claude_user_email`)
  of whoever ran the chat — alongside the deep link. Repeated Stop calls refresh
  the same task's content; a status the user changed (archived/dismissed) is
  never overwritten.

  **Cost model (changed 2026-07): the backend NEVER calls an LLM here.** The
  chat summary is produced by the Claude Code **agent** (on the user's Claude
  subscription — no API tokens) and passed in the request body as
  `{ topic, summary, next_step }`. When those are absent (the safety-net
  Stop-hook fallback), the endpoint files a **minimal no-AI trace** instead, and
  a no-summary call never overwrites an existing agent-written summary (partial
  update). So the flow is BOTH: the Stop hook's block step drives the agent to
  post a real summary every turn-cycle; the safety-net trace guarantees a row
  even if that post fails. Because the block re-fires each turn-cycle, the
  summary refreshes to reflect the latest state of the chat (a few extra seconds
  at each turn-end — the accepted trade for a $0, reliable summary).

**Provisioning (one-time):** the endpoint lives on the **Express backend
(Railway)**, not on the Next.js app at `app.smrtesy.com` (that host has no
`/api/claude-session` route and would 404). Set two things in the Claude Code
environment, copying the values from the Railway backend's service variables:
- the shared secret — `SMRTBOT_INTERNAL_SECRET` (or `CRON_SECRET`). The backend
  accepts either (`process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET`);
  Railway currently provisions `SMRTBOT_INTERNAL_SECRET`, so copy that value.
- the backend base URL — `SMRTESY_BACKEND_URL`, set to the value of the
  backend's `SMRTESY_PUBLIC_URL` (same as the app's `NEXT_PUBLIC_BACKEND_URL`,
  e.g. `https://<app>.up.railway.app`); the hook builds
  `…/api/claude-session/proposal` from it. Or set the full
  `SMRTTASK_PROPOSAL_URL` directly. Include the `https://` scheme — a
  schemeless value makes curl use `http://`, which Railway 301-redirects and a
  POST does not replay (the hook now normalizes a missing scheme to `https://`
  and follows redirects, but set it correctly anyway).

**Identity override (often required):** the endpoint files the proposal for the
smrtesy *platform* account, which may differ from the Claude Code *login* email
(e.g. a `@maor.org` Claude login vs a `@gmail.com` platform account). When they
differ, set one of `SMRTTASK_USER_ID` (most robust — bypasses email lookup) or
`SMRTTASK_USER_EMAIL` in the Claude Code environment; otherwise the hook sends
`CLAUDE_CODE_USER_EMAIL` and the backend 404s with "user not found". The
backend resolves email via a single `listUsers({ perPage: 1000 })` + local
match (the repo's proven pattern; a paginated `{ page }` loop did not resolve).

There is no baked-in URL default on purpose (a wrong host silently 404s every
turn). A missing secret **or** URL makes the hook a silent no-op. The backend
also hard-fails the auth check when neither secret env var is set, so an unset
secret can never leave the route open.

## Long-task auto-resume on token exhaustion

**Goal:** a long task that gets interrupted because the subscription's token
window ran out should **resume itself automatically** once the window resets —
without the user babysitting it. Standing request (2026-07).

**Why it's built the way it is (read this first):** Claude Code gives NO
reliable hook signal for "this session stopped because tokens ran out," and no
reset-time value. The `Stop` hook fires on a normal turn-end, not on a
usage-limit interruption, and its payload has no "stop reason" or reset field.
So we **cannot react after exhaustion**. Instead we **arm the resume up front**:
the moment a task looks long, drop a checkpoint and arm a self-binding **hourly
watchdog Routine**. If the session later dies from a usage limit, the Routine
keeps firing every hour; the first firing after the window resets continues the
task — in the **same conversation** (the Routine self-binds to this session by
default, so the resumed turn has full context). Hourly is the cron minimum and
means work resumes within ≤1 hour of the reset without ever needing to know the
exact reset time. All of this runs on the user's **Claude subscription — ZERO
paid API tokens** (creating/deleting Routines and continuing the chat are agent
actions), so it is NOT subject to the cost-approval rule.

**When to arm.** At the **start** of any task that plausibly outlives one usage
window: large multi-file changes, long migrations/audits/sweeps, anything the
user calls a "long task" / "משימה ארוכה", or work you expect to span hours. When
in doubt on a clearly big job, arm it — arming is cheap and self-cleaning.

**The protocol (agent actions):**
1. `‎.claude/hooks/longtask.sh arm "<כותרת>" "<מצב: מה נעשה + מה נשאר>" [<max_hours>]‎`
   — writes the checkpoint (`‎.claude/tmp/longtask-<slug>.json`, gitignored) and
   **prints the exact `create_trigger` parameters**. `max_hours` (default 24)
   caps the watchdog's lifetime.
2. Call **`create_trigger`** with those params: `cron_expression: "0 * * * *"`,
   the printed `prompt`, and **do NOT set `persistent_session_id`** (the default
   binds the Routine to this session).
3. `‎.claude/hooks/longtask.sh record-trigger <trigger_id>‎` — stores the id so
   the resume is armed (and the Stop-hook enforcer stops nagging).
4. As you make progress, keep the checkpoint fresh:
   `‎.claude/hooks/longtask.sh update "<מצב עדכני>"‎`.
5. **On completion:** `delete_trigger(<trigger_id>)` then
   `‎.claude/hooks/longtask.sh done‎` (removes the checkpoint). Do this so the
   watchdog doesn't keep firing after the work is finished.

**The watchdog firing** (what the Routine's prompt makes the resumed turn do):
run `longtask.sh tick` (bumps the attempt counter, prints `EXPIRED` past
`max_attempts`/`max_hours`); if `NO_CHECKPOINT` / `EXPIRED` / `status=done` →
`delete_trigger` itself and stop; otherwise continue the task from the checkpoint
+ conversation, then either `done` (finished) or `update` (more to go). So even
an orphaned Routine **self-terminates** — it can never loop forever.

**Enforcement (`Stop` hook `‎.claude/hooks/longtask-guard.sh‎`).** A shell hook
can't call the `create_trigger` MCP tool, so reliability comes from a block: on
turn-end, if an **open** checkpoint exists with **no** `trigger_id`, the hook
blocks once and instructs the agent to arm the Routine. It blocks at most 3×
per session (local counter) then degrades gracefully to "just work without a
Routine," and it is a pure **no-op for any session without an open checkpoint**
(the normal case → zero overhead). It coexists with the smrtTask summary Stop
hook without fighting it (its own counter is the loop-guard, independent of
`stop_hook_active`). Any error / non-web session / missing `jq` → exit 0.

**Caveat:** the resume depends on the `claude-code-remote` MCP tools
(`create_trigger`/`delete_trigger`) being available in the session and on the
usage limit being a *token-window* reset (not a hard account block). If a firing
still has no tokens it simply doesn't run — harmless — and the next hour retries.
