# Server routing — the gate footgun

Every app router is mounted the same way in `server/src/index.ts`:

```js
app.use("/api", platformRouter);
app.use("/api", adminRouter);
app.use("/api", smrttaskRouter);   // …and ~15 more, in order
```

They all share the `/api` prefix, so a request that matches nothing in one
router **falls through to the next**.

## The rule

Inside such a router, **`router.use(mw)` with no path applies to every request
that reaches the router** — not just its own routes. One unscoped gate therefore
gates *everything mounted after it*.

Always give a gate its router's path prefix:

```js
router.use("/tasks", requireAuth, requireOrg, requireApp("smrttask"));
router.use(["/plan", "/plans", "/plan-cells"], requireAuth, requireOrg, requireApp("smrtplan"));
```

Exception: a router that is itself **mounted on a path**
(`router.use("/knowledge", knowledgeRouter)`) already has the mount as its
scope. Say so with a `gate-scope-ok: <reason>` comment in the file — that is
also what stops the detector flagging it.

## Enforcement — run the detector, don't grep

```
node server/scripts/check-route-gates.mjs
```

Exit 1 lists every unscoped gate. It brace-matches the whole `router.use(...)`
call, so a gate split across lines cannot hide from it.

**Do not "verify" this with a line-anchored grep.** That is how the bug survived
two rounds of fixing: `^router.use(require` matches a single-line gate and
silently skips a multi-line one, so the scan came back clean twice while a live
gate was still swallowing all `/api` traffic. A check that reads the wrong shape
is worse than no check — it manufactures confidence.

## What it cost (2026-08-03)

22 unscoped gates (admin ×6, smrtTask ×8, smrtPlan, smrtStudio, smrtVault,
smrtCRM, smrtReach, smrtBot, smrtInfo, smrtVoice, daily-report). Effect: **every
endpoint mounted after them was, in production, super-admin-only**. Super-admins
pass every gate, so nothing looked wrong until the first ordinary member tried
to use the app and got `403` on literally every call — including
`/api/inbox/count`, which declares only `requireAuth + requireOrg`.

The tell, if it ever recurs: an unauthenticated request to a path that does not
exist (`/api/zzz`) returns **401 instead of 404**. Nothing should gate a route
that isn't there.
