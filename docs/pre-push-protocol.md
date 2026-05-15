# Pre-push review protocol

A non-negotiable checklist to run before `git push` on any branch with
non-trivial changes (anything beyond a typo or formatting). Drop this
file in a new project as `CLAUDE.md`, `AGENTS.md`, `docs/pre-push.md`,
or wherever your agent's startup instructions live.

The goal: **catch bugs in the same session that introduced them**, so
the user never sees a stream of "push → CI finds bug → push again"
round trips. The standard is **zero findings from automated review on
the first push.**

---

## Why this exists

Without an explicit pre-push protocol, agents tend to:

- Trust local type-check results that gave false-clean signals
  (e.g. `tsc --noEmit` returning errors that are just missing
  `node_modules`).
- Skip the real build because it's "slow" — then ESLint rules like
  `no-unused-vars` and `react-hooks/exhaustive-deps` break the deploy.
- Make small fixes without checking whether sister code makes the
  same mistake (one removed hardcoded constant in a file with three
  more hardcoded constants).
- Miss schema constraint violations because the SDK swallows the
  error silently.
- Push three commits where each fixes the previous one, polluting
  history.

Every one of those failures is preventable in 1-5 minutes of
disciplined checking before the push. This protocol codifies the
checks.

---

## Step 1 — Run the real build, not just a type-check

```bash
# whatever your project uses, ONCE per session:
npm install --no-audit --no-fund   # or pnpm install, yarn install
# then BEFORE every push:
npm run build                       # or pnpm build, yarn build, etc.
```

**The full production build is the only authoritative check** for
TypeScript / framework projects. It typically runs:

1. **TypeScript checking** — catches type errors
2. **ESLint with the project's full ruleset** — catches what tsc
   alone misses: `no-unused-vars`, `react-hooks/exhaustive-deps`,
   `import/no-duplicates`, etc.
3. **JSX / template compilation** — catches stale imports, missing
   components
4. **Bundle compilation** — catches circular imports, dead chunks

Your CI (Vercel, Netlify, GitHub Actions, etc.) runs this exact same
pipeline. **If it passes locally, it passes there.**

### Don't lean on `tsc --noEmit` as the only check

In ephemeral sandbox environments (CI containers, agent workspaces),
`tsc --noEmit` is often broken because `node_modules` isn't installed.
It will spam "Cannot find module 'react'" type errors, drowning out
the real defects and giving you a **false-clean** signal once the
noise is filtered out.

`tsc` also doesn't run ESLint at all. Errors like "variable defined
but never used" — a hard error under most Next.js / strict TypeScript
configs — never appear.

**Install first, build second.** Accept the install cost once per
session; it's reused on every subsequent build.

### Treat new errors as blockers

Pre-existing errors in unrelated files are not your problem this
session. New errors introduced by files this branch touched are
non-negotiable blockers — fix before push.

---

## Step 2 — Targeted greps for the categories of bug that slip past

The five categories below are pattern-level — they apply to any
codebase touching a database, an external API, and user-visible UI.
Adapt the specific regexes to your stack.

| # | Category | Why it slips past | Generic grep |
|---|---|---|---|
| **1** | Hardcoded constants left over from earlier single-tenant / single-environment builds | They look like legitimate config; only multi-tenant testing exposes them | `grep -rn "<known-tenant-string>\|<personal-email>\|<dev-folder-id>" <changed-dirs>` |
| **2** | Schema constraints (CHECK, NOT NULL, FK, UNIQUE) that the code violates | The SDK accepts the insert at runtime, the DB rejects with a constraint error, the code swallows it | `grep -rn "CHECK (" migrations/` for the table you're inserting to; cross-reference against the literal values your insert passes |
| **3** | API defaults you're relying on without reading | Removing a filter clause makes the API "search everything" by default, ingesting more than you meant | Read the SDK wrapper / docs for any API call whose filter behavior you just changed |
| **4** | UI promises vs backend filter direction | UI copy says "skip messages FROM X", code emits a filter for messages TO X | Trace the i18n key the user sees → through the code → to the filter value actually built; verify direction matches |
| **5** | Mutation calls without error destructuring | SDK returns `{ data, error }`; bare `await` discards `error`; failures are silent | `grep -rn "await .*\.\(insert\|update\|upsert\|delete\)(" <changed-files>` and verify each has `const { error }` |

### Each of these has caused a real production bug in the wild

- **Category 1** — A repo de-hardcoded user emails for multi-tenant
  but left a hardcoded Drive folder ID; every new tenant's Drive scan
  silently targeted the original developer's private folder and
  returned zero results.
- **Category 2** — An insert wrote `created_by: "onboarding"` against
  a `CHECK (created_by IN ('user','claude','system'))` constraint;
  the SDK call had no error check; every onboarding rule was silently
  dropped on the floor.
- **Category 3** — Removed a per-account `deliveredto:` clause from
  a Gmail query without adding `in:inbox`. Gmail's `q` parameter
  searches all labels by default; the scan started pulling Sent /
  Chats / Archive into the task pipeline.
- **Category 4** — UI input "Addresses to skip" generated rules of
  the form `to=<email>`, but the natural-language promise was "skip
  messages FROM these addresses" (i.e. `from=`). Every rule was a
  silent no-op.
- **Category 5** — A `user_settings.insert` with no `{ error }`
  destructure swallowed RLS denials; debugging took an hour to
  isolate.

Spend 30 seconds on each category. The categories are the prior
distribution of bugs this kind of work produces.

---

## Step 3 — Sub-agent code review

Spawn an independent review agent (general-purpose, fresh context,
extended thinking enabled) with a structured prompt. Independent
because YOUR context is full of the assumptions you just made — a
fresh agent sees the diff cold.

Prompt template:

> Review the staged diff at `<repo>`. Read every changed file in
> full. For each change, ask the following six questions:
>
> 1. Does any UI string the user sees promise something the backend
>    doesn't actually deliver? Trace the i18n key (or hardcoded
>    string) through to the actual implementation.
> 2. Does any DB write hit a CHECK / NOT NULL / FK / UNIQUE
>    constraint that the code isn't honoring? Cross-check by reading
>    the relevant migration file.
> 3. Does any removed code (filter clauses, fallbacks, validation,
>    guards) leave the surrounding logic silently broken? Were the
>    removed lines doing more than they looked like they were doing?
> 4. Does any new code reference a value that's hardcoded in a way
>    that breaks for non-original tenants / environments? (folder
>    IDs, emails, account names, internal hostnames)
> 5. Does any `await` on a mutation swallow the `{ error }` field?
>    Where would a silent failure show up first?
> 6. Are there off-by-one / inclusive-exclusive / time-window
>    asymmetries? (e.g. parameterized lookback paired with
>    hardcoded lookahead)
>
> For each finding, cite `file:line`, state what breaks and when,
> rate severity HIGH/MED/LOW, and propose a one-line fix. Cap report
> at 600 words. Don't propose stylistic nits.

**HIGH or MED findings block push** — fix in the same branch before
shipping. LOW is judgment — fix if cheap, ignore if not.

This step is what catches the bugs your build doesn't catch. The
build verifies the code compiles; the sub-agent verifies the code is
*correct*.

---

## Step 4 — Commit hygiene self-check

Before the push command, scan your local history:

- **Three or more commits where each fixes the previous?** Squash
  before push. Future readers will hate the noise; bisects will be
  misleading.
- **Temporary `console.log` / `print` / `dbg!` calls?** Remove.
- **Commented-out blocks of code?** Either delete or convert to a
  proper comment explaining why.
- **`TODO` left in a file you're about to ship?** Either complete or
  open a tracking issue and reference it.
- **Files that should never be committed?** `.env`, credentials,
  generated artifacts, `.DS_Store`, IDE config dirs. If `git add -A`
  picked something up that doesn't belong, remove it before commit.

---

## What this is NOT

This is not "ask the user before every push." The user has already
authorized you to push to feature branches; the point is to push
**higher-quality** work, not to add friction.

This is not "run every test in the repo for every change." Run the
tests that are relevant to what changed. A one-file UI change doesn't
need the full backend integration suite.

This is not a substitute for code review by humans. It's the
minimum bar for catching the bugs that should never make it to
human review in the first place.

---

## Adapting to your stack

The structure of this protocol is stack-agnostic; only the specific
commands vary:

| Tooling | Step 1 command | Step 2 regex source |
|---|---|---|
| Next.js / TypeScript | `npm run build` | `tsc`, `eslint`, project-specific patterns |
| Python / Django | `python manage.py check && mypy . && ruff check .` | model `validators`, schema migrations |
| Go | `go build ./... && go vet ./... && staticcheck ./...` | `// nolint` comments hiding real issues |
| Rust | `cargo check && cargo clippy -- -D warnings` | `unsafe` blocks, `unwrap()` in production paths |
| Ruby / Rails | `bin/rails zeitwerk:check && bundle exec rubocop` | model validations, schema migrations |

If your project doesn't have a clear "real build" command, you have
a tooling gap to close before this protocol can be effective. Talk
to the team about adding `npm run validate` (or equivalent) that
wraps your test + lint + typecheck in one invocation.

---

## The standard

**Zero findings from automated review on the first push.**

If automated review (your CI, your bot, your code reviewer) ever
surfaces a finding you missed, that's a signal the protocol itself
needs strengthening — not just a one-off "oh well, fix and re-push."

The protocol is the gate. Treat the bot as a backstop, not as the
quality check.
