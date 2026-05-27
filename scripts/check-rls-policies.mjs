#!/usr/bin/env node
// Guard against re-introducing broad (org-wide) RLS policies on tasks/projects.
//
// These tables must stay strictly per-user (user_id = auth.uid()) — see
// migration 20260527230000_tasks_projects_user_isolation_rls.sql. A permissive
// org-scoped SELECT policy OR's with the per-user policy and silently re-opens
// cross-user reads from the browser client.
//
// The migration files are replayed in timestamp order, tracking each policy's
// create/drop lifecycle, so only policies that are STILL LIVE at the end are
// considered — a historical org policy that was later dropped is ignored.
// A still-live policy on tasks/projects that references org-level columns fails
// the build.
//
// Intentional, narrowly-scoped org sharing (the planned org-project feature)
// can opt out per-statement by including the marker `rls-guard:allow` in a
// comment inside the CREATE/ALTER POLICY statement.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const GUARDED = new Set(["tasks", "projects"]);
const ORG_REFERENCE = /\borganization_id\b|\borg_members\b|\borg_id\b/i;
const ALLOW_MARKER = /rls-guard:allow/i;
const CREATE_RE = /(?:create|alter)\s+policy\s+"?([^"\s]+)"?\s+on\s+(?:public\.)?(\w+)/i;
const DROP_RE = /drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\s]+)"?\s+on\s+(?:public\.)?(\w+)/i;

// key = `${table}:${policyName}` -> { table, file, org, allow }
const live = new Map();

for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  for (const stmt of sql.split(";")) {
    const drop = DROP_RE.exec(stmt);
    if (drop && GUARDED.has(drop[2].toLowerCase())) {
      live.delete(`${drop[2].toLowerCase()}:${drop[1]}`);
      continue;
    }
    const create = CREATE_RE.exec(stmt);
    if (create && GUARDED.has(create[2].toLowerCase())) {
      const table = create[2].toLowerCase();
      live.set(`${table}:${create[1]}`, {
        table,
        file,
        org: ORG_REFERENCE.test(stmt),
        allow: ALLOW_MARKER.test(stmt),
      });
    }
  }
}

const violations = [...live.values()].filter((p) => p.org && !p.allow);

if (violations.length > 0) {
  console.error("\n✖ RLS guard: a live org-scoped policy exists on a per-user table.\n");
  for (const v of violations) {
    console.error(`  ${v.file}  (on ${v.table})`);
  }
  console.error(
    "\n  tasks/projects must stay user-isolated (user_id = auth.uid()).\n" +
      "  A policy referencing organization_id/org_members re-opens cross-user reads.\n" +
      "  If this org sharing is intentional and correctly scoped, add the comment\n" +
      "  `-- rls-guard:allow` inside the CREATE/ALTER POLICY statement.\n",
  );
  process.exit(1);
}

console.log("✓ RLS guard: tasks/projects policies are per-user only.");
