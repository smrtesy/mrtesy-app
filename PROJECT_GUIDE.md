# PROJECT_GUIDE.md — superseded

> **This guide is superseded by [`docs/codebase-map.md`](docs/codebase-map.md)**
> — the living system map, auto-loaded into every Claude session via the
> `@docs/codebase-map.md` import in [`CLAUDE.md`](CLAUDE.md) and kept fresh by
> the same-commit rule + the `.claude/hooks/map-guard.sh` push gate. Working
> rules live in `CLAUDE.md`; area detail in the path-scoped
> [`.claude/rules/`](.claude/rules/) files.
>
> The full old text froze on **2026-05-06** and described an architecture that
> no longer exists — a single hardcoded user, no orgs/apps/entitlements,
> "all changes straight to `main`, no feature branches" (contradicting the
> current pre-push protocol), "edge functions never auto-deploy from GitHub"
> (they deploy via the `Deploy to Supabase` Action on every push to `main`),
> `tsc --noEmit` as the quality gate (superseded by the full build protocol).
> Nothing loaded it into sessions, so nothing kept it honest — a session that
> opened it by chance was actively misled. That is exactly the failure the
> codebase map's enforced freshness is built to prevent.
>
> The last full version is in git history: commit `70a37a2`
> (`git show 70a37a2:PROJECT_GUIDE.md`).

Where the content moved:

| Was here | Now lives in |
|---|---|
| The three engines + deploys | `docs/codebase-map.md` § The three engines |
| Pages / screens | `docs/codebase-map.md` § The apps |
| Server background jobs | `docs/codebase-map.md` § Server layout |
| Edge functions table | `docs/codebase-map.md` § Edge functions |
| Database tables | `docs/codebase-map.md` § Database |
| Filter-rules system | `.claude/rules/smrttask-server.md` (+ map § Database) |
| Agent working rules, verification, push discipline | `CLAUDE.md` (the only authoritative copy) |
