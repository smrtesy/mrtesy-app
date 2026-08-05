# CLAUDE.md

Operating instructions for Claude working in this repo. Read this at the start
of every session before touching code.

## Codebase map — loaded into every session; keep it fresh

@docs/codebase-map.md

The line above imports `docs/codebase-map.md` — the platform-wide "where is
what" index (the three engines, the apps, server/frontend layout, core
tables) — into **every** session on every surface, including the in-app
Claude console (repo threads clone this repo, so the import rides along).
Answer "where is X" from the map instead of re-exploring the tree, and open
the deep-dive doc it points to when you need more.

**Freshness is enforced, not remembered** (same lesson as the Stop-hook
session summaries): any structural change — an app, server module,
components dir, screen/route-group dir, or edge function added, removed, or
moved — updates `docs/codebase-map.md` (content **and** its `Verified:`
date) **in the same commit**, like the two-i18n-files rule. Enforcement is
the PreToolUse hook `.claude/hooks/map-guard.sh`: it blocks any `git push`
whose commits change the directory tree at the exact levels the map
enumerates without touching the map in the same range (deterministic
`ls-tree` diff vs `origin/main`, zero AI, fail-open on any infra error;
emergency bypass `MAP_GUARD_SKIP=1 git push …` — then fix the map in the
next commit). The hook cannot see *semantic* drift — a new core table, a
screen whose meaning changed, a responsibility that moved — those are
covered by the same-commit rule and the pre-push protocol check (Step 2).

Area detail deliberately lives OUT of the always-loaded map, in path-scoped
rules that load only when a session touches matching files:
`.claude/rules/claude-console.md`, `panes.md`, `smrttask-server.md`,
`edge-functions.md`. When an area grows its own conventions, add/extend a
rule file there — don't grow the map past its ~200-line budget.
`PROJECT_GUIDE.md` is superseded by the map (it froze on 2026-05-06 and had
drifted into misinformation; the stub that remains says where everything
moved).

## תוכנית ai chochom — שירות ייעוץ פתרונות AI (טעון בכל סשן)

**התוכנית המלאה:** `docs/ai-chochom-plan.md` — מקור-האמת של כל משימות
ai chochom. סשן שעובד על משימת chochom קורא קודם את בלוק המשימה שם + את
הסקיל שלה ב-`.claude/skills/chochom-*/`. **אין לאלתר נתיבי תוצרים** — רק
מפת התוצרים שבתוכנית. הענף הקנוני: `main` (תוצר שלא הגיע אליו לא קיים).
מזהה התוכנית ב-smrtPlan: `SMRTPLAN_PLAN_ID_CHOCHOM` (env).

- **עלות:** פעולה בתשלום עד $5 בתוך תקציב-שלב מאושר — "כן" בסשן; מעל —
  משימת-אישור למנהל. תקציבי שלבים ועצירה ב-80% — בתוכנית (§עלויות).
  עבודת קלוד על המנוי — חינם, בלי אישור.
- **מחקר:** רק לפי פרוטוקול המחקר שבתוכנית — תוכנית-מחקר לפני החיפוש
  הראשון (נאכף ב-hooks: `research-gate.sh`/`research-guard.sh`; עבודה מול
  הכלי: `.claude/hooks/research.sh`).
- **תקרת דלגציה:** עד **2** סוכני-משנה במקביל; לא לפזר עבודה שנסגרת בכמה
  קריאות-כלי; **בלי אימות-עצמי** ובלי "שלב אימות" בסקילים.
- **חסמי-אורך:** תשובה לעובד = צעדים ממוספרים, צעד = פעולה אחת, בלי
  הקדמות ונרטיב; מעל ~10 צעדים — עצור ושאל מה נתקע. מסמכים לדיסק — אורך
  לפי הצורך, בלי ריפוד.
- **עזרה לעובד:** "אני אוחז במשימה N בתוכנית ai chochom, לא מובן לי ___"
  → קרא את בלוק המשימה בתוכנית + הסקיל, וענה צעד-אחר-צעד בעברית פשוטה.

## Response language — match the user's opening language

Reply in **the language the user opened the conversation in**. First message in
Hebrew → reply in Hebrew; in English → reply in English. Decide from the opening
message and stay consistent for that session. (Superseded the earlier
"always Hebrew" rule on 2026-08-04 at the user's request — replying in the user's
own opening language also cuts tokens when that language is English, since Hebrew
encodes to more tokens per character.)

Code, identifiers, file paths, and commit/PR text keep the existing repo
conventions (English where the repo already uses English) — only the prose you
address to the user follows the opening language.

**מונחים עבריים טהורים — לא ז'רגון לועזי מתועתק** (החלטת המשתמש, 8/2026;
מסונכרן בשלושת הריפו). בכל טקסט המופנה למשתמש — צ'אט, מסמכי-תוכנית, תיאורי
משימות, סקילים — מונח-שיטה נכתב בעברית, לא כתעתיק לועזי. **מילון-התרגום
הקבוע — תמיד בתוקף; זה המקום להוסיף כל מונח חדש שנקבע:**

| לועזי | עברי (תמיד) |
|---|---|
| spike / ספייק | חקירה קצרה |
| bake-off / בייק-אוף | בדיקת השוואה |
| batch | הרצה |

אין מקבילה עברית מקובלת — מנסחים במילים פשוטות, לא ממציאים תעתיק. חריג:
שמות-מוצר, מזהי-קוד/נתיבים, ומונחים טכניים שהם ממשק ממשי (API, token,
endpoint) נשארים כמות שהם.

## Timezone — always New York (America/New_York)

The user is based in **New York**. Present **all** dates, times, and
time-of-day the user sees in the **America/New_York** timezone (US Eastern,
EST/EDT with DST) — **never** in Israel time (`Asia/Jerusalem`) and never in
raw UTC. This is a standing preference and applies to **all** sessions,
including Claude Code on the web.

- Any time/date in prose you address to the user (chat replies, summaries,
  explanations, reminders, task previews) is stated in New York time. When it
  helps avoid ambiguity, label it (e.g. "14:00 ניו יורק").
- When you write or review code that formats a date/time for the user, or
  schedules something on the user's behalf (reminders, cron/`send_later`,
  calendar events, task due dates shown in the UI), use `America/New_York`
  as the display/target timezone unless the code deliberately needs UTC for
  storage. Store timestamps in UTC as usual; convert to New York only at the
  display / user-facing boundary.
- If you're given a time without a zone from a user-facing context, assume
  it's New York time.

## Actionable instructions — step-by-step, verified, direct links

Whenever the user needs to **do something themselves** — anything where the
answer is "you have to go somewhere and perform steps" (change a setting,
click a button, run an action, fill a form, fix something in an external
tool or dashboard) — do **not** answer with a vague "go here, then go
there." Instead:

1. **Check the actual platform first.** Before writing the steps, look at
   the real, current state of wherever you're sending the user — the live
   page, the current UI, the current admin panel, the current settings
   screen, the current version of the third-party tool. Use whatever access
   you have (the codebase for our own screens, WebFetch/tools for external
   platforms, reading the route/component that renders the screen) to
   confirm what the user will actually see **right now**, not what it looked
   like months ago or what you remember. UIs change; verify before you
   instruct.
2. **Give numbered, step-by-step instructions** — one concrete action per
   step, in order, in the exact words/labels the user will see on screen
   (in the correct language of that UI). No "somewhere in settings"; say
   the exact menu → tab → button path.
3. **Give a direct link to the deepest point possible.** Send the user
   straight to the exact page/screen/section where the action happens — not
   the homepage, not the top-level domain. Include the full deep URL with
   any path, query params, IDs, and fragments needed to land them exactly
   there. If the flow spans several pages, give the deep link for each step
   that has one. One click should land the user on the right screen. This
   is the same deep-link principle as the product rule below — it applies to
   instructions I give the user in chat, too.
4. **State the moment the instructions were verified** when it matters
   (e.g. "as of today's UI"), so the user knows they're current, and flag if
   any step is your best guess because you couldn't verify the live state.

**Keys, secrets, and credentials — always say exactly where to find them.**
Whenever an instruction tells the user to use a specific key, token, secret,
password, env var, connection string, ID, or any credential, you MUST also
give **verified** instructions on **where to find that exact value** — do
not just name it and leave the user hunting. Before answering, check the
real source (the Railway/Vercel/Supabase dashboard, the repo's `.env` /
config, the settings screen, the provider's console — whatever actually
holds it) and tell the user the precise location: which service, which
page/section, which variable name, plus a direct deep link to that screen.
Name the exact key label so it's unambiguous (e.g. `SMRTBOT_INTERNAL_SECRET`
in Railway → project → the backend service → Variables tab). If several
keys look similar, say which one and how to tell them apart. If you can't
verify the live location, say so and give your best-known path flagged as
unverified — never invent a location.

This is a standing preference and applies to **all** sessions, including
Claude Code on the web. The point: the whole system exists to make the user
as efficient as possible — every extra hop, every "look for it yourself,"
every generic domain link is wasted effort. Do the verification and the
navigation work for the user up front.

## Cost approval — explicit, up-front, non-negotiable

**Any action that will spend the user's money requires the user's explicit,
up-front approval of the estimated cost — every time.** This covers anything
that consumes **paid API / LLM tokens billed to the user's services**
(Anthropic, Voyage, Gemini, or any paid API), in particular when triggered on
the backend — e.g. the smrtInfo extraction / `/info/extract/batch`, running the
classifier or any summarizer manually, `quick-action`, or any batch/loop that
racks up such calls. Before running such an action you MUST:

1. State what it will do and which service gets billed.
2. Give a concrete cost estimate — per-item **and** total.
3. Wait for an explicit **"go"** on the cost. A generic "should I proceed?" is
   NOT enough — the user must approve the **cost** specifically.

Work the Claude Code **agent** does itself runs on the user's Claude
subscription and is **not** billed as API tokens — that does not need cost
approval. The line is **paid API/token spend billed to the user**. When unsure
whether something costs money, assume it does and ask first.

Why this rule exists: a large batch-extraction run and repeated backend LLM
summaries were triggered without the user approving the spend. Standing
instruction (2026-07): no money-spending action without explicit cost sign-off.

**Two refinements (user decision, 2026-07-31):**

1. **In-app actions approve themselves.** Spend the USER triggers in the
   product UI, where the price is visible at the point of action (e.g. the
   voice-provider picker showing "$1.50 one-time" / "$2/month"), needs NO
   chat-level approval — the click is the approval. The corollary is a build
   requirement: any UI action that spends money must show its price at the
   decision point. Chat approval is only for spend *Claude* initiates.
2. **Micro-test envelope (≤$3).** Small technical validation runs Claude
   initiates (a voice-clone test, a model probe, a few TTS lines) are
   pre-approved up to **$3 cumulative per test**, with the actual spend
   reported in the summary. Above the cap — explicit approval as before.
   (Generalizes the video-lab `/expert` micro-experiments envelope of
   2026-07-30; kept in sync across the three repos.)

## smrtTask task-ingest mode (trigger-gated)

If the user's first message in the session begins with the phrase
**"עדכון משימות"**, read `CLAUDE-smrttask-ingest.md` before doing
anything else and follow it for the entire session. The first action
in that mode is to send the user an explicit acknowledgement that the
file is active and that the rules apply (project matching, table
preview, no DB writes without explicit approval). Do not invoke
that flow unless the trigger phrase is present at the start.

## Claude session hooks — moved out (2026-08-04)

The `session-proposal` Stop-hook mechanism (disabled) and the `long-task
auto-resume` protocol (outdated — see below) were **removed from CLAUDE.md to cut
always-loaded tokens**. Full historical detail + re-enable steps:
`docs/claude-session-hooks.md`. The `longtask-guard.sh` Stop hook was removed
from `.claude/settings.json` and its scripts deleted; long-task resume, if
revived, must be rewritten against `RemoteTrigger`/`CronCreate`.

## Token & session efficiency

The always-loaded context is billed on **every** turn (each tool call re-reads the
whole context from cache), so the levers that matter are context size and turn
count — not the length of replies. Four habits:

**Batch read-only tool calls.** Independent `curl`/`grep`/`wc`/`ls` calls go in
one Bash command (`&&`/`;`), not a separate round each. Read a focused slice
(grep→offset/limit), not a whole file, when you know what you are after. Do not
re-read what has not changed. **Never** skip real production-state checks or
post-fix behaviour verification — those are essential, not "extra tools".

**Subagents are a trade-off, not a free speedup.** A subagent runs its own separate
context, so its reads/greps stay out of the main context and it returns only a
conclusion — a real saving for a *broad* investigation. But it pays its own base
cost, so for a task that closes in 2–3 tool calls it costs more than it saves. Use
one for a wide search you can summarise; not for a 2–3-call task. Cap: 2 in
parallel.

**Propose a split at the natural seam — proactively.** When a debugging/exploration
session reaches its **diagnosis** (root cause found, next step is the fix) and the
context has grown past ~50% of the window (~100K), **offer on your own** to
summarise in two lines (problem + fix location) and continue in a **new
conversation**. A fresh session starts at ~57K instead of ~150K; because cost grows
quadratically with turns, splitting at the seam saves the most. Offer it, do not
force it — if the fix genuinely needs the full investigation inline, say so. (A
built-in split control in the console is planned; until then, offer it in chat.)

## Push target — main by default

**Shared across all three repos** (`mrtesy-app`, `video-lab`, `voice-engine`):
this push & merge policy is kept in sync — a change to it in one repo is
mirrored in the other two in the same effort, so all three stay structurally
identical. Each repo adapts only the platform-specific parts: the build/test
command and the deploy-verify method (Vercel `/api/deploy-info` here; Railway
`/health` in voice-engine; none in video-lab, which has no production deploy).

The user has standing authorization to push fixes directly to `main` once the
pre-push protocol (below) is clean. Workflow on a feature branch is:

1. Run the full pre-push protocol on the feature branch (build, greps,
   sub-agent review).
2. `git fetch origin main` and merge `origin/main` into the feature branch
   first — confirm no merge conflicts and the build still passes.
3. Give `main` its **own distinct commit** — never a shared SHA with the
   feature branch. Merge the feature branch into `main` with `--no-ff` so
   `main` gets a fresh merge commit even when a fast-forward is possible:

   ```
   git checkout main && git merge origin/main --ff-only   # sync main first
   git merge --no-ff <feature-branch> -m "Merge <feature-branch> into main"
   git push origin main
   git checkout <feature-branch> && git push origin <feature-branch>
   ```

   Do **NOT** fast-forward `main` to the feature branch's tip (the old
   workflow). That left `main` and the feature branch pointing at the
   *identical* SHA, and Vercel de-duplicates deployments by commit SHA:
   when both refs are pushed near-simultaneously, whichever branch's
   webhook Vercel processes first "claims" the single build. If the
   feature branch wins that race the build is published as a **Preview**
   and `main`'s **Production** deployment never advances — the fix silently
   ships to a preview URL only. A `--no-ff` merge gives `main` a
   main-only SHA, so its push always produces its own Production build and
   there is no race. (This bit us on the whatsapp-receipts push: the fix
   built as a Preview and Production stayed on the previous commit.)

If the merge produces conflicts, stop and surface them to the user
instead of resolving silently. If the post-merge build fails, fix the
failures on the feature branch before touching `main`.

Verify each push actually succeeded — read git's own exit status, not a
piped command's. `git push … | tail` reports `tail`'s exit code (0) even
when the push was rejected (non-fast-forward), which silently hides a
failed push. If a push is rejected, `git fetch origin main` and redo the
`--no-ff` merge onto the updated `main` before retrying.

**Deployed is not fixed — verify the BEHAVIOUR, not just the SHA.** After the
deploy lands, exercise the thing you changed and read the real numbers (a probe
that distinguishes fixed from broken, the queue count, the error rate). On
2026-08-03 two separate bugs were found this way, and *both were in that
session's own fixes*: an attempts cap that would have discarded the whole
backlog it existed to protect, and a rate-limit rejection wrongly counted
against a row's retries. Neither was visible from "push succeeded"; both were
obvious the moment the production numbers were read.

After pushing `main`, confirm Production actually advanced: curl
`https://app.smrtesy.com/api/deploy-info` and check `commit_short` matches
the SHA you pushed (Vercel takes a few minutes to build). If it's stuck on
the old commit or shows the fix as a Preview only, the one-click recovery
is Vercel dashboard → the built deployment's `⋯` → **Promote to Production**.

This overrides the "never push to a different branch without explicit
permission" line in the harness's git-branch instructions — that explicit
permission is now standing for `main`.

## Deploy queue — server/** changes ship through `scripts/ship.sh` (mrtesy-app only)

**This section is mrtesy-app-specific** — it does NOT sync to the other two
repos, because it exists for one problem only this repo has: the in-app Claude
console runner lives inside the Railway `server/` process, and every push to
`main` that touches `server/**` redeploys that process, which `SIGTERM`s every
other live console run. Frontend/docs pushes don't redeploy the backend, so
they're unaffected. Full design: `docs/claude-console/deploy-queue-plan.md`.

**Do not push `main` by hand — call the shipping gate.** Once the pre-push
protocol below is clean on your feature branch, ship with:

```
scripts/ship.sh <feature-branch> [title]
```

`ship.sh` makes the deterministic membership decision
(`git diff --name-only origin/main...HEAD | grep '^server/'`) and does the right
thing:

| Condition | What `ship.sh` does |
|---|---|
| `DEPLOY_QUEUE_ENABLED=1` **and** diff touches `server/**` | Pushes the **branch**, POSTs `/claude-deploy/mark-ready`, and stops — `main` is untouched. A background coordinator merges the whole `ready` batch and redeploys **once**. |
| flag off, **or** no `server/**` change (frontend/docs) | Today's `--no-ff` merge into `main` + push — exactly the shared workflow above. |

**The flag is ARMED.** `DEPLOY_QUEUE_ENABLED` is a Railway env var on the backend
service, **set to `1` since 2026-08-04** — the queue and the phase-3 coordinator
are **live in production**. Every `server/**` change now routes through the queue:
`ship.sh` pushes the branch + marks it `ready`, and the background coordinator
merges the whole `ready` batch and redeploys **once**. A manual `git push origin
main` carrying a `server/**` change is blocked by `deploy-gate.sh` — use `ship.sh`.
Frontend/docs pushes are unaffected: Railway's `watchPatterns` for the backend
service is `["/server/**"]` (verified 2026-08-04), so only server changes redeploy
it. To disarm, set the var to `0` or delete it in Railway → Variables (that also
disarms the coordinator, which no-ops unless the value is exactly `1`).

**Root cause of the recurring `conflict` parking — FIXED 2026-08-05 (commit
`fix/deploy-coord-missing-refspec`).** For months a server-only branch that was a
clean fast-forward over `origin/main`, alone in the queue, with `origin/main` NOT
moving, was still parked terminal `conflict` on every `mark-ready` retry. Two
earlier diagnoses were **both wrong** and neither fixed it: (a) "transient conflict
— origin/main moved mid-batch" (the transient re-fetch/reset-to-ready retry that
guards against it **is** built, `runBatchDeploy`); (b) "dirty `DEPLOY_DIR` checkout"
(the `merge --abort`/`reset --hard`/`clean -fd` scrub before touching main **is**
built too, `prepWorkspace`). Both were built and the bug survived, because the real
cause was elsewhere: `DEPLOY_DIR` is cloned `git clone --depth 1 --branch main`,
which gives it a **single-branch fetch refspec** (`+refs/heads/main:…`). A plain
`git fetch origin <branch>` therefore landed the tip only in `FETCH_HEAD` and
**never created `refs/remotes/origin/<branch>`** — so `git merge --no-ff
origin/<branch>` (and `branchInMain`'s `merge-base --is-ancestor`) could not resolve
the ref, exited non-zero, and the coordinator **misread every non-zero merge exit as
a merge conflict**. Deterministic, not intermittent — which is why it hit *every*
server change once the flag was armed (2026-08-04) and re-`mark-ready` never helped
(same broken fetch each time). The fix: fetch with an explicit refspec
`+<branch>:refs/remotes/origin/<branch>` so the tracking ref is written despite the
single-branch clone (both fetch sites in `deploy-coordinator.ts`). Lesson for the
next stall: a `conflict` on a branch that *cannot* textually conflict is almost
never a real merge conflict — read what the merge command actually exited on
(unresolved ref? unrelated histories?) before theorising, and don't misclassify a
non-zero `git` exit as a content conflict.

**If the queue ever strands a clean branch again:** confirm it in the coordinator
logs (does `origin/<branch>` resolve in `DEPLOY_DIR`?), and as an escape hatch ship
that one fix via the documented bypass — rebuild it as a clean server-only branch
off fresh `origin/main` and `DEPLOY_GATE_SKIP=1 git push origin main` after a
`--no-ff` merge.

**Pre-push protocol ordering, for server changes:** run the **full** pre-push
protocol on the feature branch **before** calling `ship.sh` — i.e. before the fix
enters the queue, not before a push to `main`. Only a clean branch should reach
`mark-ready` (`ready`); the coordinator adds one integration build on the merged
batch, it does not re-run each fix's review. Frontend/docs are unchanged: protocol,
then `ship.sh` pushes straight to `main`.

**Backstop hook.** `.claude/hooks/deploy-gate.sh` (PreToolUse on Bash) blocks a
manual `git push origin main` that carries a `server/**` change while the flag is
on, and tells you to use `ship.sh` instead. It is inert with the flag off. It
only catches a hand-push that bypasses `ship.sh` — the script is the real gate.
Emergency bypass: `DEPLOY_GATE_SKIP=1 git push …`.

## Pre-push review protocol — non-negotiable

Before `git push` on any branch with non-trivial changes (anything beyond a
typo or formatting), run the full sequence below. Do not ask the user
permission to run it — run it. Do not push without it.

The goal is to catch bugs in the same session that introduced them, so the
user never sees a stream of "push → bot finds bug → push again" round trips.
The standard is **zero findings from Claude Code Review on the first push.**

### Step 0 — A justification is a trigger to read, never a substitute for reading

This step runs **while you author the change**, not before the push. It is
first because the failure it prevents happens at write time, and every
end-of-line check below is too late to catch it cheaply.

**The rule:** the moment you write a sentence explaining why a change is
complete / sufficient / safe / covers every case — in a code comment, a commit
message, or a reply to the user — **stop and read the code path end to end.**
That sentence is a claim, not a check. Then either:

- **Keep it, with the evidence**: a claim of completeness must cite the
  `file:line` it was verified against. "Handles every state" is worthless;
  "all seven states in the task `status` union (`src/types/task.ts:34`) are
  handled" is checkable by the next reader — including a reviewer who wants to
  prove you wrong. (That union is the real example: `pending_completion` is the
  state the delayed-silent-close bug below hid in.)
- **Or delete it.** An uncited completeness claim in a comment is worse than no
  comment: it tells the next session the path was verified when it wasn't, so
  the bug gets read past instead of found.

**Longer reasoning makes this failure worse, not better.** More thinking
produces a more airtight-sounding justification for the same unverified claim —
it raises your confidence without touching the facts. Depth of reasoning is
never a substitute for a lookup. If the answer is checkable, check it.

**The three classes that actually bit us** — each with the question to answer
by reading, not by reasoning:

| Class | The question, answered from the code |
|---|---|
| State machines / enums | Did I enumerate the states from the type definition, or from memory? Read the enum. A state I forgot is a silent no-op or a delayed write. |
| Sweeps, deletes, resets, "recovery" paths | What is the actual blast radius of this `WHERE` clause / this loop? Run the SELECT before writing the DELETE. |
| Cross-references | Does the target exist — the section heading, the anchor, the function, the column, the i18n key? Grep for it. |

**Evidence this is real, not hygiene theatre** (2026-07-28): four review rounds
in one session found **seven** of my own fixes incomplete. Two were dangerous —
a "user confirms" state that was a delayed silent close (the exact bug the
change existed to prevent), and a recovery sweep that would have deleted the
five live classifier rules it was built to protect. In **three** of the seven,
the fix was incomplete *precisely where I had written out why it was
sufficient* — confidence was inversely correlated with correctness. That
inversion is the signature of this failure, and the justification-sentence is
its earliest visible symptom.

Note this is the same lesson as "A model may propose; only code may confirm a
checkable fact" further down this file, turned on the agent's own workflow
rather than on the product's AI calls. That section was written, and the code
checks it demands were built, *during the same session that produced the seven
partial fixes*. Shipping the rule is not following it.

### Step 1 — Real build (not just tsc)

```
npm install --no-audit --no-fund && npm run build
```

**`npm run build` is the only authoritative check.** It runs the
Next.js production build which combines TypeScript checking, ESLint
(with `react-hooks/exhaustive-deps`, `@typescript-eslint/no-unused-vars`,
etc. — rules that catch what tsc alone misses), and JSX/MDX compilation.
Vercel runs exactly the same pipeline; if it passes locally, it passes
there.

Do NOT lean on `tsc --noEmit` as the only check. In this sandbox tsc
fails on missing `node_modules` and reports "Cannot find module 'react'"
type errors that are environmental, masking real type errors and giving
a false-clean signal. Install first, build second.

Catching ESLint errors here saves a deploy cycle. Real categories that
have slipped past in this repo: `@typescript-eslint/no-unused-vars`
(unused props after refactor), `react-hooks/exhaustive-deps` (hooks
referenced in callbacks but missing from deps), `TS2451` duplicate
declarations from parallel agent edits, double-imports.

Treat any new error in files this branch touched as a blocker.
Pre-existing errors in unrelated files are not your problem this session.

If `npm install` is slow on a given sandbox, accept the cost once per
session — every subsequent build reuses the install. Iterating with
`tsc --noEmit` between fixes is fine after the initial install, since
tsc resolves node_modules from there.

### Step 2 — Targeted greps for the categories of bug that slip past me

For each category, grep before push. These are the patterns that produced
real bugs in this repo's history (commit `705d2eb` fixed four of them in
one go — every one was preventable with a 30-second grep).

| Category | What to grep for | Why |
|---|---|---|
| Hardcoded constants left over from single-tenant builds | `grep -rn '"1wDog\|noreply@maor\|@maor.org\|chanoch'` in changed files' neighbors | The Drive folder fallback footgun; my_emails hardcoding; etc. |
| Schema CHECK constraints I might violate | `grep -rn "CHECK (" supabase/migrations/ \| grep <table>` for any table I'm inserting to | `created_by IN ('user','claude','system')` would have caught the `"onboarding"` bug |
| API defaults I'm relying on without knowing them | Read the docs page or local wrapper for any Google/Supabase/SDK call whose filter behavior I just changed | Gmail `q` searching all labels by default would have caught the missing `in:inbox` |
| Semantic mismatch between UI strings and backend filter direction | Read the i18n key the user-visible label resolves to, then trace the trigger value all the way through `parseSkipRules` (or the equivalent runtime check) | The skip-rule `to=` vs `from=` bug |
| Insert/update without `{ error }` destructuring | `grep -n "await supabase.from.*\\.\\(insert\\|update\\|upsert\\)(" -A0` in changed files | Silent CHECK violations, silent RLS denials |
| A "clean" scan that reads the wrong shape | Any grep you are about to treat as PROOF that you fixed every instance — check it against the real code shape first (multi-line? renamed middleware? nested mount?), or replace it with a parser | A line-anchored `^router.use(require` reported clean twice while a live gate was still 403'ing all of `/api`. Detector: `node server/scripts/check-route-gates.mjs`; rule: `.claude/rules/server-routing.md` |
| Structural drift vs the codebase map | Did the branch add/move/remove an app, server module, components dir, screen/route-group dir, or edge function? If yes — `docs/codebase-map.md` must change in the same range | The map loads into every session; a stale map misleads them all. `map-guard.sh` auto-blocks the tree-visible cases at push time; semantic drift (a new core table, a moved responsibility) only this check catches |

### Step 3 — Sub-agent code review

Spawn an `Explore` or `general-purpose` agent with a focused prompt:

> Review the staged diff of branch `<branch>` at `/home/user/mrtesy-app`.
> Read every changed file in full. For each change, ask:
>
> 1. Does any UI string the user sees promise something the backend doesn't deliver?
> 2. Does any DB write hit a CHECK / NOT NULL / FK / unique constraint that
>    I'm not honoring? Cross-check by reading the relevant migration file.
> 3. Does any removed code (especially filter clauses, fallbacks, validation)
>    leave the surrounding logic silently broken?
> 4. Does any new code reference a value that's hardcoded in a way that
>    breaks for non-original tenants? (folder IDs, emails, account names)
> 5. Does any `await` on a query swallow the `{ error }` field?
> 6. Are there off-by-one / inclusive-exclusive / time-window asymmetries?
>    (e.g. lookback parameterized but lookahead hardcoded)
>
> For each finding, cite file:line, state what breaks and when, rate
> severity HIGH/MED/LOW, and propose a one-line fix. Cap report at 600
> words. Do not propose stylistic nits.

Treat any HIGH or MED finding as a blocker. Fix it in the same branch
before push. LOW is judgment — fix if cheap, ignore if not.

### Step 3b — Browser page-check (propose when a screen changed) — opt-in

Steps 1–3 are all **static** — build, greps, reading the diff. None of them
opens the screen, so a runtime regression (a JS error on mount, an API call
that breaks, an element that never renders, a control that doesn't respond)
sails through. Step 3b closes that gap by driving the changed screen in a real
browser as a real user.

**This step is a PROPOSAL, not a gate.** When the diff touches a screen
(`src/app/**` or `src/components/**`), offer to run the page-check on that
screen and let the user say yes/no — do not block the push on it, and do not
run it without a "yes". (When the user asks for it directly, just run it.)

How it works — the **`page-check`** skill (`.claude/skills/page-check/`):
`node scripts/page-check.mjs <path> [--scenario <file>]` boots the CHANGED
branch locally (`next dev` — the live app runs old `main`, so only a local run
reflects the change), logs in as the real user via a session the backend mints
(`GET /api/claude-session/app-access`, reusing `mintSessionCookies` in
`server/src/modules/claude/app-access.ts`), opens the screen in the
pre-installed Chromium, runs a **full interaction scenario**
(`.claude/page-checks/<screen>.mjs` — navigate, click, fill, assert), and
reports every console error / page error / failed request it saw. Exit 0 =
pass. Zero paid tokens (browser on the subscription). Full design:
`docs/browser-page-test-plan.md`.

The mint endpoint is live only after this change is on `main` and deployed to
Railway; until then `--no-auth` runs a render-only check. Scenarios are
read-only by default — one that writes to the real DB must clean up after
itself.

### Step 4 — Update app status if you touched an app's files

If this push includes changes to `server/src/apps/<slug>/` or any feature
clearly owned by a specific app, update that app's status via:

```
PATCH /api/admin/apps/<slug>/status
body: {
  stage:      "<שלב נוכחי: רעיון|בניה|טסט|מאור|לקוחות>",
  summary:    "<מה המצב עכשיו — בעברית פשוטה, משפט-שניים>",
  next_steps: ["<מה הבא 1>", "<מה הבא 2>"],
  blockers:   ["<חוסם אם יש>"]
}
```

Valid stages (in order): `רעיון` → `בניה` → `טסט` → `מאור` → `לקוחות`

Use the `api()` helper or call the endpoint directly. If the status hasn't
materially changed (e.g. a one-line bugfix), skip this step. If you added a
significant feature, milestone, or changed direction — update it.

### Step 5 — Self-check on commit hygiene

- Are there 3+ commits where each fixes the previous? Squash before push,
  or at least keep the noise out of `main` (use `git rebase -i` only if user
  has explicitly authorized).
- Did I leave a temporary `console.log`, `TODO`, or commented-out block?
- Did I add a file that should never be committed (`.env`, credentials)?

## What this is NOT

This is not "ask the user before pushing." The user has already approved
that I push to feature branches. The point is to push higher-quality work,
not to add friction.

This is not "run every test in the repo." If there's a test suite that's
relevant to the change, run it. Don't run the whole suite for a one-file
change.

## Why this exists

PR #1 went through four rounds of "Claude Code Review finds bugs, I fix,
push again" because I skipped this protocol. Thirteen real bugs across
those rounds — every single one of which a 1-minute grep, schema read,
or sub-agent review would have caught locally.

The user explicitly told me they no longer want to rely on the GitHub
Claude Code Review bot as the quality gate. **The sub-agent review I run
in Step 3 of this protocol IS the gate.** The bot may stay enabled as a
silent safety net — if it ever surfaces a finding I missed, the protocol
itself is broken and needs strengthening. The default expectation is
that the bot finds nothing because I caught it first.

This is not about avoiding work. It's about doing the work *before* the
push, in one session, so the user sees a clean PR instead of a stream
of fix-up commits.

## Product naming convention

All product names follow the pattern **`smrt` + English word**:
- `smrt` is always lowercase, no space, attached directly to the word
- The following word is a valid English word, either `camelCase` (e.g. `smrtTask`) or all-lowercase (e.g. `smrtcrm`)
- Correct: `smrtTask`, `smrtCRM`, `smrtHR`, `smrtMail`
- Incorrect: `SmartTask`, `smrt-task`, `smrttsk` (abbreviation), `smrtמשימות`
- The platform itself is **smrtesy** (the name, not subject to this rule)
- App slugs in the DB follow the same pattern (lowercase): `smrttask`, `smrtcrm`

## Product principles — apply across the whole system

- **Preserve deep links — never strip a URL down to its domain**.
  The user's instruction (May 2026): "the whole point of this system is
  to be as efficient as possible — instead of giving me a general link
  to the main domain of the site, give me the original link I sent that
  leads directly to where I want to go." This is system-wide, not a
  merge-only rule. Whenever any AI-generated content (task descriptions,
  checklist items, summaries, suggestion bodies, reminders, etc.)
  references something the user linked to, **emit the exact deep URL
  verbatim** — including query params, fragments, message IDs, doc IDs.
  Never paraphrase `https://site.com/products/foo?ref=bar` down to
  `site.com`. If a checklist item maps to multiple links, list them
  all on the item. Same applies to Gmail message URLs, Drive doc IDs,
  Calendar event links, WhatsApp message links. **One click should
  always land the user on the right page**, not the homepage.

  Where to enforce: every Sonnet/Haiku system prompt that produces
  user-facing text. When you write a new AI prompt, add an explicit
  "preserve URLs verbatim" clause. When you review an existing one
  that doesn't have it, add it.

- **Compact, minimal UI — every new feature defaults to collapsed/quiet**.
  The user's instruction (June 2026, prompted by the WhatsApp search bar):
  keep the interface compact and minimal — don't add permanent chrome that
  sits on screen taking space when it isn't in use. When you add any
  feature with a surface (search, filters, sort controls, bulk actions,
  advanced options, etc.):
  - **Default to collapsed.** Show a small icon button (next to the title
    / in the header), and reveal the full control only when the user
    clicks it. The WhatsApp chat search is the reference implementation:
    a `Search` icon by the list, click → the input row expands; close
    (X / Escape) → it collapses and resets. See
    `src/components/smrttask/whatsapp/WhatsAppReader.tsx`.
  - Prefer icon buttons + tooltips over always-on labelled inputs.
  - Don't stack rows of controls above content. One quiet entry point
    that expands on demand beats a permanent toolbar.
  - Reuse existing density/spacing of the surrounding screen — match the
    neighbours, don't introduce a bulkier pattern.
  When in doubt, the smaller, hidden-until-needed version is the right
  call. This applies to every app/screen, not just WhatsApp.

- **Minimum-effort-for-the-user is the default design goal**.
  The user's instruction (2026-08-04, prompted by managed-secrets making him
  hand-type a variable name and paste a project id the platform already held):
  whenever you plan or build ANYTHING for the user — a feature, screen, flow,
  form, tool — the default is **the least possible manual work for him**. Any
  value the system already knows (an env var, an id, a token, a name) must be
  **auto-loaded / pre-filled**, never re-typed. Any field derivable from
  another (e.g. a target's `env_var_name` from the secret's `key_name`) is
  **pre-filled by default**, editable if needed. Any step that can be skipped
  is skipped. If the user has to type, paste, or hunt for a value the system
  could have supplied itself, that is a **design bug**, not a minor nicety —
  fix it. Pair this with the deep-link and compact-UI principles above: the
  whole system exists to make the user maximally efficient, so every extra
  hop you leave in is wasted effort. **Kept in sync across the three repos**
  (`mrtesy-app`, `video-lab`, `voice-engine`) like the other standing
  preferences.

## Project conventions worth remembering

- **Tabs-workspace panes (router-based)**: sidebar screens render as
  component panes via `src/lib/panes/registry.tsx`. The hard rules for any
  screen work (registry wrapper, `useScreen*`/`PaneLink` nav,
  `useOptionalPaneNav()` guard, no viewport heights, `OpenTabLink` for
  sibling tabs) live in `.claude/rules/panes.md` — loaded automatically when
  touching `src/app/**`, `src/components/**`, or `src/lib/panes/**`. Full
  picture: docs/router-panes-plan.md.

- **Edge function imports — NEVER use `https://esm.sh/...`** — use the
  Deno-native specifiers (`npm:…` / `jsr:…`) instead. The why (esm.sh 522s
  break the whole deploy Action) and the exact substitutions live in
  `.claude/rules/edge-functions.md` — loaded automatically when touching
  `supabase/functions/**`.
- **i18n**: every user-visible string goes through `useTranslations()` /
  `getTranslations()` and resolves to a key in `src/messages/{he,en}.json`.
  Never write `locale === "he" ? "..." : "..."` ternaries. If a key is
  missing, add it to both files in the same commit that uses it.
- **API client**: frontend → backend always goes through `api()` from
  `@/lib/api/client.ts`, which auto-attaches `Authorization` and
  `X-Org-Id`. Raw `fetch()` to `/api/*` is a bug.
- **Org scoping**: every backend route that touches user/tenant data
  requires `requireAuth + requireOrg + requireApp("<app-slug>")` — the
  per-app slug, e.g. `requireApp("smrttask")` or `requireApp("smrtvoice")`
  (the legacy `"smrtesy"` slug was renamed to `"smrttask"` in migration
  `20260518000004`). Exceptions: admin routes (`requireSuperAdmin`) and
  per-user-no-org routes (`/api/me/*`).
- **Service-role Supabase**: use `createAdminSupabaseClient()` from
  `@/lib/supabase/admin.ts`. Never instantiate `createClient` with the
  service key inline in a page or component.
- **Skip rules**: addresses entered by users go to `rules_memory` with
  trigger `from=<email>` for emails and `domain=<dom>` for domains.
  `created_by` must be one of `('user','claude','system')`. Always
  destructure `{ error }` from the insert.
- **Gmail queries**: include `in:inbox` unless you have a documented
  reason to scan other labels. Gmail's `q` parameter searches all labels
  by default (excluding Trash/Spam).
- **Drive scanning**: opt-in only. If `user_settings.drive_folder_id` is
  null and no explicit folder is passed, return `[]` and skip — never
  fall back to a hardcoded folder ID.

## A model may propose; only code may confirm a checkable fact

**Never let a model verdict be the only gate on a destructive or
irreversible write.** When an AI decision leads to something the user
can't easily undo — merging two tasks, closing/dismissing a task,
overwriting a title or description, binding a thread to a task — every
part of that decision which is *checkable in data* must be re-checked in
code, and the model's claim about it discarded.

The model's job is **semantics** ("is this the same matter?"). It must
never be the authority on **facts** ("is this the same person / number /
address / invoice / date / amount?"). Those are lookups, and a model that
wants to say yes will invent them: the T1804 case (2026-07-27) was Haiku
asserting `3475848008 = 972584146670` to justify a merge, which fused
מענדי's message into לאה's task. Another one said the numbers "match,
probably a typo" — and still returned `high` confidence.

**A prompt sentence is NOT a fix for this class of bug.** That is the
lesson to take, because it is what kept this exact complaint coming back:
"חיבר הודעות שלא קשורות" was "fixed" on 2026-06-01, 06-08, 06-12 and
06-25, and every one of those fixes was another instruction added to a
prompt ("NEVER match on person alone", "A shared chat is NOT a shared
matter", "Do not staple an unrelated new message onto an old
suggestion"). A prompt is a request; it reduces the frequency and removes
nothing. If you catch yourself fixing a wrong-merge / wrong-attachment
bug by adding a sentence to a prompt, stop: write the code check instead,
and keep the prompt line only as a cheap first filter.

The shape that works, in `ai-process`:
1. **Verify in code, from the data.** `partiesConflict()` compares the
   incoming message's channel counterparty (sender address / chat phone —
   never numbers scraped from the body) against the candidate task's, and
   the task's identity includes the message it was born from.
2. **Downgrade, don't drop.** A verified mismatch costs one tier: `high`
   becomes a suggestion the user accepts from the existing "כפילות
   אפשרית" banner, `medium` disappears. Nothing is lost and nothing is
   silently rewritten.
3. **Fail closed.** A lookup that errors must report the unsafe answer as
   unproven — never "no conflict found".
4. **Leave the non-verdicts explicit.** One side anonymous (calendar,
   Drive, a task with no contact) or nothing comparable (a chat phone vs
   an email-only task) is *unverifiable*, not *proven different* — those
   still merge, which is what keeps genuine cross-source links working.

**Then add a detector, because code can regress too.** The invariant is
checked hourly in the DB by `public.check_cross_party_merges()` (pg_cron
job `cross-party-merge-monitor`, migration `20260727220000`): any task
carrying an update from a different chat, where the phone is not
verifiably the same party, writes a `log_entries` row with
`level='error'`, `category='dupe_cross_party'` plus a notification. The
daily health-check Routine already reports every `level='error'` category
over 24h, so a regression surfaces in the next morning's inbox report
instead of six weeks later. It was validated against 120 days of history:
it flags all 23 real incidents and produces zero false alarms. When you
change the merge logic, re-run the detector's query over recent history —
if it starts flagging legitimate merges, the code veto and the detector
have drifted apart (`phone_keys_8` in SQL mirrors `phoneKeys` in TS).

Generalise this: **code check + downgrade + fail closed + a detector on
the invariant.** Any place a model decision writes something the user
can't cheaply undo deserves the same four.

## Migration discipline

When you write SQL DDL/DML the user wants persisted, always create a numbered
file under `supabase/migrations/` named `YYYYMMDDHHMMSS_<slug>.sql` so the
change is tracked in git.

Whether you apply it to production yourself turns on one question — **does it
delete or change existing data?**

- **Does NOT delete or modify existing data** (`CREATE TABLE/INDEX`,
  `ADD COLUMN/CONSTRAINT`, `COMMENT`, a `cron.schedule`, and the like):
  **apply it yourself** via `mcp__supabase__apply_migration`, then verify.
  No approval needed.
- **Deletes or changes existing data** (`DROP`, `DELETE`, `TRUNCATE`, an
  `UPDATE` that changes rows, `ALTER COLUMN TYPE` / `SET NOT NULL`, or anything
  else that rewrites or removes existing data): **do not apply.** First run a
  read-only `SELECT` to show exactly what will change (which rows / how many),
  present that to the user, and apply only after explicit approval.

## Planning / design docs — commit and share a GitHub link

The user strongly prefers reading docs **on GitHub**, not in chat or as
attachments. Whenever you author a substantial doc — a `docs/*-plan.md`,
a design spec, an investigation write-up — **commit it to the repo and
push**, then give the user the GitHub link to the file (on the branch you
pushed to, e.g. `https://github.com/smrtesy/mrtesy-app/blob/<branch>/docs/<file>.md`).
A docs-only commit doesn't need the full pre-push build protocol (it
touches no code) — just commit and push. Do this by default for any plan
you write for approval, so the user can read it comfortably before saying
go.

## When the user is mid-onboarding and stuck

The (app)/layout.tsx redirects to /onboarding when `onboarding_completed
= false`. Super-admins are exempt (we wired this in PR #1). If a regular
user is stuck:

- Light reset: set `onboarding_completed = false`, clear
  `initial_scan_*` flags. They restart at step 1 with credentials intact.
- Medium reset: also delete `user_credentials` for Gmail/Drive/Calendar
  + set the `*_connected` booleans to false. They re-OAuth.
- Full reset: delete the auth.users row in a transaction that first
  removes org/app_memberships/user_settings/user_credentials. Supabase
  cascades for product tables.

Always confirm scope with AskUserQuestion before doing any of these.
