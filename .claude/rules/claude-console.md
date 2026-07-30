---
paths:
  - "server/src/modules/claude/**"
  - "src/components/claude/**"
---

# The in-app Claude console — how it actually works

The `/claude` screen runs the real Claude Code engine on the Railway backend.
Frontend: `src/components/claude/` (ClaudeChat, ChatComposer, ProjectPanel,
PlaybookList, StandingInstructions, RepoPicker, SplitReview, DecomposeReview,
ClaudeRunsClient, ApprovalsPanel). Server: `server/src/modules/claude/`.

## Design decisions (don't re-litigate them by accident)

- **CLI, not Agent SDK** (`runner.ts` header): the runner spawns
  `claude -p … --output-format stream-json` and stores every stream event in
  `claude_run_events`. The SDK wraps the same engine — swapping later is
  drop-in.
- **Billing:** runs authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (subscription,
  zero paid API tokens). `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are
  **stripped** from the child env so a stray key can't silently bill the run.
  Secrets live in `app_secrets` under the `smrttask` slug
  (`/admin/apps/smrttask/secrets`), env-var fallback: `CLAUDE_CODE_OAUTH_TOKEN`,
  `GITHUB_TOKEN`.
- **A thread is a conversation:** each turn resumes the thread's engine session
  (`--resume`); the session id is re-written after every successful turn
  because `--resume` mints a new id. The workspace (`workspace.ts`) is a stable
  per-thread dir under the OS temp dir — required for resume to work and for
  turn 2 to see turn 1's files. Swept after 7 days; deleted with the thread.
- **Repo work:** `github.ts` clones depth-1 once per thread (idempotent
  `ensureClone`) and authenticates via an env credential helper scoped to
  github.com — the token never touches disk; `redact()` scrubs it from
  anything stored. The clone contains the repo's CLAUDE.md, so the codebase
  map (`docs/codebase-map.md`) loads automatically in repo threads.
- **Resume fallback:** Railway containers are ephemeral. A `--resume` whose
  transcript is gone retries once as a fresh session and records
  `resumed_session: null` (the "context lost" banner).
- **Thread split:** method A = `--fork-session` from the parent's session (in
  the parent's workspace — `workspace_thread_id`); method B = seed-context
  prepended to the child's first prompt.
- **First-turn composition** (`playbooks.ts:composePrompt`): environment
  preamble → standing instructions (`claude_instructions`, one row per org) →
  chosen playbook (`claude_playbooks`) → the user's task. Budgeted to 100 KB
  because the prompt is a single argv entry (Linux MAX_ARG_STRLEN).
- **`runOneShot`** runs short prompts (titles, analyses) with no
  `claude_runs` row — a title is not a turn of the conversation.
- **Autonomy gate** (`actions.ts`, `actions-routes.ts`, `sqlClassify.ts`;
  design `docs/claude-console/autonomy-safety-gate.md`): repo runs get FULL shell
  (`--permission-mode bypassPermissions` in `runner.ts`) — reversible work (merge to
  main after a green build, additive `supabase db push`) is autonomous. The one
  irreversible action, a DESTRUCTIVE migration, routes through a human: the run calls
  the m2m `POST /claude-action/request-approval` (internal-secret gated; env injected
  by the runner), `sqlClassify.ts` classifies the SQL in code (allowlist, fail-closed),
  and a destructive verdict lands a `claude_action_approvals` row the operator approves
  from `ApprovalsPanel` (which enqueues the apply run). All run secrets — GitHub token,
  internal secret, OAuth token, app-access token — are scrubbed from stored events by
  `redactSecrets` in `runner.ts`.
- **Deploy status** (`deploy-status.ts`, route `GET /claude/deploy-status`,
  `DeployStatusBadge`): Vercel (frontend) + Railway (backend) production build state
  via their official APIs — richer than `/api/deploy-info` (in-flight building/ready/
  error, both surfaces). Tokens read at call time from app_secrets (`VERCEL_TOKEN`,
  optional `VERCEL_PROJECT_ID`/`VERCEL_TEAM_ID`; `RAILWAY_TOKEN` + `RAILWAY_PROJECT_ID`,
  service/environment auto-resolved or pinned via `RAILWAY_SERVICE_ID`/
  `RAILWAY_ENVIRONMENT_ID`). Each provider degrades to `configured:false` with a hint
  when its token is unset; the badge is invisible until then.
- **App access, two layers** (`app-access.ts`): every turn mints a short-lived
  Supabase session for the launching user — injected (1) as `SMRTESY_API_TOKEN`
  for direct API calls, and (2) as `@supabase/ssr` cookies for a REAL headless
  Chromium (`browser-helper.ts`, shipped in dist; shot/text/run commands). The
  ONLY pre-approved shell command is `node <helper path>` (repeated
  `--allowedTools` rules scoped to the literal path in `runner.ts`). Run
  screenshots post back via `POST /claude/runs/:id/attachments`
  (`source='run'`, running-status gate) and render inline in ClaudeChat via
  signed URLs. Session revoked (`scope:'local'`) when the run ends. Requires
  `INSTALL_CHROMIUM=1` on Railway (same binary as the admin domain-tracker).

## Tables (14, all org-scoped)

`claude_threads`, `claude_runs`, `claude_run_events`, `claude_instructions`,
`claude_playbooks`, `claude_attachments`, `claude_actions`, `claude_topics`,
`claude_thread_topics`, `claude_thread_analyses`, `claude_daily_identity`,
`claude_known_workers`, `claude_manager_proposals`, `claude_action_approvals`
(the autonomy gate's destructive-migration approval queue). Authoritative shapes:
`grep -rn "<table>" supabase/migrations/`.

## Docs

`docs/claude-console/` — plan.md, feasibility.md, app-integration-plan.md,
standing-instructions.md (the living copy is the DB row, edited in-app),
threads-split-and-group-plan.md, project-decompose-and-board.md.
