/**
 * botsite → smrtesy migration (one-time).
 *
 * Migrates botsite contacts/tags/groups into smrtCRM, performing the
 * CROSS-BOT MERGE that the platform's per-org model requires: botsite scoped
 * uniqueness to bot_id, smrtesy scopes it to org_id, so the same person who
 * appeared under several bots collapses into ONE contact — and each source bot
 * contributes its project tag (CRM-1 / CRM-3). See
 * docs/smrtcrm-smrtreach-open-questions.md and the build plan §13–15.
 *
 * ── Dependency-free by design ────────────────────────────────────────────────
 * The server has no `pg` driver, and we don't want to add one for a one-off.
 * Instead the operator exports the botsite tables to JSON once, then this
 * script consumes those files and writes to Supabase via the service-role
 * client. Export commands (run against the botsite Postgres):
 *
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM contacts t"                > contacts.json
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM contact_tags t"            > contact_tags.json
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM contact_tag_assignments t" > contact_tag_assignments.json
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM contact_groups t"          > contact_groups.json
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM contact_group_members t"   > contact_group_members.json
 *   psql "$BOTSITE_URL" -At -c "SELECT json_agg(t) FROM bots t"                    > bots.json   # optional, for project tag names
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   TARGET_ORG_ID=<uuid> MIGRATION_USER_ID=<uuid> \
 *   npx tsx src/scripts/migrate-botsite.ts --input ./botsite-export [--dry-run]
 *
 * Reuses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (via ../db) for the target.
 *
 * ── Source schema assumptions (verified from botsite src/contacts) ───────────
 *   contacts: id(int), bot_id(int), phone, email, first_name, last_name,
 *             source, email_unsubscribed(bool), custom_fields(jsonb), notes
 *   contact_tags: id(int), bot_id(int), name
 *   contact_tag_assignments: contact_id(int), tag_id(int)
 *   contact_groups: id(int), bot_id(int), name [, description]
 *   contact_group_members: group_id(int), contact_id(int)
 *   bots: id(int), name   (optional)
 * Adjust the field names below if your dump differs.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "../db";
import { normalizeEmail, normalizePhone } from "../modules/smrtcrm/contacts-service";

// ── config ───────────────────────────────────────────────────────────────────
const INPUT_DIR = argValue("--input") ?? "./botsite-export";
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const ORG_ID = process.env.TARGET_ORG_ID ?? "";
const USER_ID = process.env.MIGRATION_USER_ID ?? "";
const BATCH = 500;

// ── source row shapes ──────────────────────────────────────────────────────────
interface SrcContact {
  id: number;
  bot_id: number | null;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  source: string | null;
  email_unsubscribed: boolean | null;
  custom_fields: Record<string, unknown> | null;
  notes: string | null;
}
interface SrcTag { id: number; bot_id: number | null; name: string }
interface SrcTagAssign { contact_id: number; tag_id: number }
interface SrcGroup { id: number; bot_id: number | null; name: string; description?: string | null }
interface SrcGroupMember { group_id: number; contact_id: number }
interface SrcBot { id: number; name: string }

// ── helpers ──────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadJson<T>(file: string): T[] {
  const path = join(INPUT_DIR, file);
  if (!existsSync(path)) {
    console.warn(`  (skip) ${file} not found`);
    return [];
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw || raw === "null") return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/** Map botsite source strings onto the smrtcrm_contacts.source CHECK set. */
function mapSource(sources: (string | null)[]): "manual" | "csv" | "bot" | "api" | "migration" {
  const s = sources.filter(Boolean).map((x) => String(x).toLowerCase());
  if (s.some((x) => x.includes("bot"))) return "bot";
  if (s.some((x) => x.includes("csv") || x.includes("import"))) return "csv";
  if (s.some((x) => x.includes("api"))) return "api";
  if (s.some((x) => x === "manual")) return "manual";
  return "migration";
}

async function insertInBatches(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (DRY_RUN || rows.length === 0) return rows.length;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await db.from(table).insert(chunk);
    if (error) throw new Error(`insert ${table}: ${error.message}`);
    done += chunk.length;
  }
  return done;
}

// ── union-find for the cross-bot merge ───────────────────────────────────────
class UnionFind {
  private parent = new Map<number, number>();
  add(x: number) { if (!this.parent.has(x)) this.parent.set(x, x); }
  find(x: number): number {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path-compress
    let cur = x;
    while (this.parent.get(cur) !== root) { const next = this.parent.get(cur)!; this.parent.set(cur, root); cur = next; }
    return root;
  }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!ORG_ID || !USER_ID) {
    console.error("ERROR: TARGET_ORG_ID and MIGRATION_USER_ID env vars are required.");
    process.exit(1);
  }
  console.log(`botsite → smrtesy migration${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log(`  input:  ${INPUT_DIR}`);
  console.log(`  org:    ${ORG_ID}`);

  // Idempotency guard: this script INSERTs (not upserts) with fresh UUIDs, so a
  // second run would duplicate contacts and then collide on the unique indexes,
  // aborting mid-way. Refuse to run into a non-empty org unless --force.
  if (!DRY_RUN) {
    const { count, error } = await db
      .from("smrtcrm_contacts")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ORG_ID);
    if (error) { console.error(`ERROR: precheck failed: ${error.message}`); process.exit(1); }
    if ((count ?? 0) > 0 && !FORCE) {
      console.error(
        `ERROR: org already has ${count} contacts. This script is a one-time import.\n` +
        `       To wipe and re-import, first run:\n` +
        `         DELETE FROM smrtcrm_group_members WHERE org_id='${ORG_ID}';\n` +
        `         DELETE FROM smrtcrm_tag_assignments WHERE org_id='${ORG_ID}';\n` +
        `         DELETE FROM smrtcrm_groups WHERE org_id='${ORG_ID}';\n` +
        `         DELETE FROM smrtcrm_tags WHERE org_id='${ORG_ID}';\n` +
        `         DELETE FROM smrtcrm_contacts WHERE org_id='${ORG_ID}';\n` +
        `       then re-run, or pass --force to append (may create duplicates).`,
      );
      process.exit(1);
    }
  }

  // 1. Load source data.
  const contacts = loadJson<SrcContact>("contacts.json");
  const srcTags = loadJson<SrcTag>("contact_tags.json");
  const srcTagAssigns = loadJson<SrcTagAssign>("contact_tag_assignments.json");
  const srcGroups = loadJson<SrcGroup>("contact_groups.json");
  const srcGroupMembers = loadJson<SrcGroupMember>("contact_group_members.json");
  const bots = loadJson<SrcBot>("bots.json");
  const botName = new Map<number, string>(bots.map((b) => [b.id, b.name]));
  console.log(`  loaded: ${contacts.length} contacts, ${srcTags.length} tags, ${srcGroups.length} groups`);

  // 2. Normalize + union-find merge by shared phone OR shared email.
  const uf = new UnionFind();
  const norm = new Map<number, { phone: string | null; email: string | null }>();
  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();

  for (const c of contacts) {
    uf.add(c.id);
    const phone = normalizePhone(c.phone);
    const email = normalizeEmail(c.email);
    norm.set(c.id, { phone, email });
    if (phone) {
      const seen = byPhone.get(phone);
      if (seen !== undefined) uf.union(seen, c.id); else byPhone.set(phone, c.id);
    }
    if (email) {
      const seen = byEmail.get(email);
      if (seen !== undefined) uf.union(seen, c.id); else byEmail.set(email, c.id);
    }
  }

  // 3. Build merged groups keyed by component root.
  interface Merged {
    uuid: string;
    members: SrcContact[];
    bots: Set<number>;
  }
  const groups = new Map<number, Merged>();
  for (const c of contacts) {
    const root = uf.find(c.id);
    let g = groups.get(root);
    if (!g) { g = { uuid: randomUUID(), members: [], bots: new Set() }; groups.set(root, g); }
    g.members.push(c);
    if (c.bot_id != null) g.bots.add(c.bot_id);
  }

  // old contact id → merged uuid
  const contactIdMap = new Map<number, string>();
  for (const g of groups.values()) for (const m of g.members) contactIdMap.set(m.id, g.uuid);

  // 4. Build merged contact rows (COALESCE; keep first non-null, record extras).
  const contactRows: Record<string, unknown>[] = [];
  for (const g of groups.values()) {
    const sorted = [...g.members]; // input order ≈ creation order
    const firstNonNull = <K extends keyof SrcContact>(k: K) =>
      sorted.map((m) => m[k]).find((v) => v != null && v !== "") ?? null;

    const phones = [...new Set(sorted.map((m) => norm.get(m.id)!.phone).filter(Boolean))] as string[];
    const emails = [...new Set(sorted.map((m) => norm.get(m.id)!.email).filter(Boolean))] as string[];
    // Reverse so the FIRST member wins on key collision — consistent with
    // firstNonNull() above (which keeps the earliest scalar value).
    const customMerged: Record<string, unknown> = {};
    for (const m of [...sorted].reverse()) Object.assign(customMerged, m.custom_fields ?? {});
    // Traceability for values dropped by the merge.
    if (phones.length > 1) customMerged._merged_phones = phones;
    if (emails.length > 1) customMerged._merged_emails = emails;

    contactRows.push({
      id: g.uuid,
      org_id: ORG_ID,
      created_by: USER_ID,
      first_name: firstNonNull("first_name"),
      last_name: firstNonNull("last_name"),
      phone: phones[0] ?? null,
      email: emails[0] ?? null,
      source: mapSource(sorted.map((m) => m.source)),
      notes: firstNonNull("notes"),
      custom_fields: customMerged,
      email_unsubscribed: sorted.some((m) => m.email_unsubscribed === true),
    });
  }

  // 5. Tags: migrate existing custom tags + create one project tag per bot.
  const tagIdMap = new Map<number, string>();        // old botsite tag id → new uuid
  const projectTagByBot = new Map<number, string>(); // bot_id → project tag uuid
  const tagRows: Record<string, unknown>[] = [];
  const tagNameToId = new Map<string, string>();     // dedupe by name within org (UNIQUE(org_id,name))

  for (const tg of srcTags) {
    const name = tg.name?.trim();
    if (!name) continue;
    let uuid = tagNameToId.get(name);
    if (!uuid) {
      uuid = randomUUID();
      tagNameToId.set(name, uuid);
      tagRows.push({ id: uuid, org_id: ORG_ID, name, kind: "manual", created_by: USER_ID });
    }
    tagIdMap.set(tg.id, uuid);
  }

  const allBots = new Set<number>();
  for (const g of groups.values()) for (const b of g.bots) allBots.add(b);
  for (const botId of allBots) {
    // Project tags must be their own kind='project' rows. If the bot's name
    // already exists as a custom tag (UNIQUE(org_id,name) would forbid a second
    // row), disambiguate so we never silently fold into a manual tag and lose
    // the project semantics + bot_ref.
    const base = (botName.get(botId) ?? `פרויקט ${botId}`).trim();
    let name = base;
    if (tagNameToId.has(name)) name = `${base} (פרויקט)`;
    while (tagNameToId.has(name)) name = `${base} (פרויקט ${botId})`;
    const uuid = randomUUID();
    tagNameToId.set(name, uuid);
    tagRows.push({ id: uuid, org_id: ORG_ID, name, kind: "project", bot_ref: String(botId), created_by: USER_ID });
    projectTagByBot.set(botId, uuid);
  }

  // 6. Tag assignments: remap + dedupe (merge may collapse many → one contact).
  const assignSeen = new Set<string>();
  const assignRows: Record<string, unknown>[] = [];
  function addAssign(contactUuid: string, tagUuid: string) {
    const key = `${contactUuid}:${tagUuid}`;
    if (assignSeen.has(key)) return;
    assignSeen.add(key);
    assignRows.push({ org_id: ORG_ID, contact_id: contactUuid, tag_id: tagUuid });
  }
  for (const a of srcTagAssigns) {
    const cu = contactIdMap.get(a.contact_id);
    const tu = tagIdMap.get(a.tag_id);
    if (cu && tu) addAssign(cu, tu);
  }
  // Project tags: every merged contact gets a tag for each source bot.
  for (const g of groups.values()) for (const b of g.bots) {
    const tu = projectTagByBot.get(b);
    if (tu) addAssign(g.uuid, tu);
  }

  // 7. Groups + members (remap + dedupe).
  const groupIdMap = new Map<number, string>();
  const groupRows: Record<string, unknown>[] = [];
  const groupNameToId = new Map<string, string>();
  for (const gr of srcGroups) {
    const name = gr.name?.trim();
    if (!name) continue;
    let uuid = groupNameToId.get(name);
    if (!uuid) {
      uuid = randomUUID();
      groupNameToId.set(name, uuid);
      groupRows.push({ id: uuid, org_id: ORG_ID, name, description: gr.description ?? null, created_by: USER_ID });
    }
    groupIdMap.set(gr.id, uuid);
  }
  const memberSeen = new Set<string>();
  const memberRows: Record<string, unknown>[] = [];
  for (const gm of srcGroupMembers) {
    const gu = groupIdMap.get(gm.group_id);
    const cu = contactIdMap.get(gm.contact_id);
    if (!gu || !cu) continue;
    const key = `${gu}:${cu}`;
    if (memberSeen.has(key)) continue;
    memberSeen.add(key);
    memberRows.push({ org_id: ORG_ID, group_id: gu, contact_id: cu });
  }

  // 8. Report + write (order respects FKs: contacts & tags → assignments; groups → members).
  console.log("\nplanned writes:");
  console.log(`  contacts:        ${contactRows.length}  (merged from ${contacts.length}; ${contacts.length - contactRows.length} duplicates collapsed)`);
  console.log(`  tags:            ${tagRows.length}  (of which project: ${allBots.size}; custom deduped by name)`);
  console.log(`  tag_assignments: ${assignRows.length}`);
  console.log(`  groups:          ${groupRows.length}`);
  console.log(`  group_members:   ${memberRows.length}`);

  if (DRY_RUN) { console.log("\nDRY RUN complete — nothing written."); return; }

  console.log("\nwriting…");
  console.log(`  contacts:        ${await insertInBatches("smrtcrm_contacts", contactRows)}`);
  console.log(`  tags:            ${await insertInBatches("smrtcrm_tags", tagRows)}`);
  console.log(`  tag_assignments: ${await insertInBatches("smrtcrm_tag_assignments", assignRows)}`);
  console.log(`  groups:          ${await insertInBatches("smrtcrm_groups", groupRows)}`);
  console.log(`  group_members:   ${await insertInBatches("smrtcrm_group_members", memberRows)}`);
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("\nMIGRATION FAILED:", e instanceof Error ? e.message : e);
  console.error(
    "Writes are not transactional. If it failed mid-way, clean up before retrying:\n" +
    `  DELETE FROM smrtcrm_group_members  WHERE org_id='${ORG_ID}';\n` +
    `  DELETE FROM smrtcrm_tag_assignments WHERE org_id='${ORG_ID}';\n` +
    `  DELETE FROM smrtcrm_groups          WHERE org_id='${ORG_ID}';\n` +
    `  DELETE FROM smrtcrm_tags            WHERE org_id='${ORG_ID}';\n` +
    `  DELETE FROM smrtcrm_contacts        WHERE org_id='${ORG_ID}';`,
  );
  process.exit(1);
});
