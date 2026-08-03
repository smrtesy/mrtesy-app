#!/usr/bin/env node
/**
 * Detector: an auth/entitlement gate declared WITHOUT a path.
 *
 * The bug it exists to prevent (2026-08-03, took three fix rounds to close):
 * every app router is mounted with `app.use("/api", <router>)`, one after
 * another. Inside such a router, `router.use(mw)` with no path runs for EVERY
 * /api request that falls through to it — not just that router's own routes. So
 * a single unscoped gate turned every endpoint mounted after it into
 * "super-admin only" / "smrtTask only". Super-admins passed every gate, so the
 * app looked healthy right up until the first ordinary member tried to use it.
 *
 * Why a script and not a line in CLAUDE.md: this was "fixed" twice with a
 * line-anchored grep (`^router.use(require`) that silently skipped the
 * multi-line declarations — a check that looks exhaustive but reads the wrong
 * shape is worse than no check, because it manufactures confidence. This
 * scanner brace-matches the whole call, so formatting cannot hide a gate.
 *
 * Passing requires one of:
 *   • the first argument is a path ("/x" or ["/x","/y"]), or
 *   • the file carries an explicit `gate-scope-ok:` comment stating why the
 *     unscoped gate is safe (e.g. the router is MOUNTED on a path, which makes
 *     the mount the scope — see routes/knowledge.ts).
 *
 * Usage: node server/scripts/check-route-gates.mjs   (exit 1 = a bare gate)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const GATE_HINTS = ["require", "attachTaskAccess"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Text of the arguments to a call whose "(" sits at `open`, brace-matched. */
function argsAt(src, open) {
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
    i++;
  }
  return src.slice(open + 1, i - 1);
}

const findings = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  if (src.includes("gate-scope-ok:")) continue; // explicitly justified in-file
  const re = /router\.use\(/g;
  let m;
  while ((m = re.exec(src))) {
    const args = argsAt(src, m.index + "router.use".length).trim();
    if (!args) continue;
    const isGate = GATE_HINTS.some((h) => args.includes(h));
    if (!isGate) continue; // mounting a sub-router, not a gate
    const first = args.split(",")[0].trim();
    if (first.startsWith('"') || first.startsWith("[") || first.startsWith("`")) continue;
    const line = src.slice(0, m.index).split("\n").length;
    findings.push(`${file.replace(ROOT, "server/src")}:${line}`);
  }
}

if (findings.length) {
  console.error("Unscoped router.use() gate — this runs for EVERY /api request");
  console.error("that reaches the router, not just its own routes:\n");
  for (const f of findings) console.error("  " + f);
  console.error(
    '\nGive the gate its router\'s path prefix, e.g.\n' +
      '  router.use("/tasks", requireAuth, requireOrg, requireApp("smrttask"));\n' +
      "or, if the router is MOUNTED on a path so the mount is already the scope,\n" +
      'add a `gate-scope-ok: <reason>` comment in the file.\n',
  );
  process.exit(1);
}
console.log(`route-gates: clean (${walk(ROOT).length} files scanned)`);
