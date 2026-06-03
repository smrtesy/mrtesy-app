#!/usr/bin/env node
/**
 * smrtBot — botsite dump → smrtbot_* data migration.
 *
 * Parses a pg_dump (COPY text format) of the legacy botsite DB and loads the
 * config/content tables into smrtbot_* under one org, remapping the integer
 * bot id → the new uuid. Contacts (→smrtCRM), email (→smrtReach) and the
 * historical log tables are intentionally skipped.
 *
 * Usage:
 *   node scripts/smrtbot-migrate-dump.mjs --dump <file> --org <uuid> [--dry-run]
 *
 * Env (non-dry-run): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Single live bot today, so the bot remap is 1→1. The script is written to
 * handle multiple bots too (keyed by legacy id).
 */
import { readFileSync } from "node:fs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ── COPY text-format parser ─────────────────────────────────
function unescape(v) {
  if (v === "\\N") return null;
  return v
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

/** Parse all `COPY public.<t> (cols) FROM stdin;` blocks → { table: [rows] }. */
function parseDump(text) {
  const lines = text.split("\n");
  const out = {};
  let table = null;
  let cols = [];
  for (const line of lines) {
    if (table === null) {
      const m = line.match(/^COPY public\.(\w+) \(([^)]*)\) FROM stdin;/);
      if (m) {
        table = m[1];
        cols = m[2].split(",").map((c) => c.trim());
        out[table] = [];
      }
      continue;
    }
    if (line === "\\.") { table = null; cols = []; continue; }
    const parts = line.split("\t");
    const rec = {};
    cols.forEach((c, i) => { rec[c] = unescape(parts[i] ?? "\\N"); });
    out[table].push(rec);
  }
  return out;
}

// ── target column sets (from the smrtbot schema) ────────────
const T = {
  smrtbot_wa_users: ["phone","name","state_json","share_tickets","last_interaction_at","wa_opted_out","wa_opted_out_at"],
  smrtbot_menu_nodes: ["node_key","type","label","title_he","body_text","buttons","extra_buttons","extra_body","action","parent_key","sort_order","active","category","image_url","image_mode","env","version"],
  smrtbot_messages: ["msg_key","label","text","category","buttons","image_url","image_mode","env","version"],
  smrtbot_missions: ["mission_id","title","mission_type","content","option_1","option_2","option_3","correct_option","reward_diamonds","success_message","related_video_id","active","sort_order","env","version"],
  smrtbot_trivia: ["video_id","level","question","option_1","option_2","option_3","correct_option","source","active","env","version"],
  smrtbot_raffles: ["raffle_date","hebrew_date","status","raffle_type","winner_child_id","coupon_code","notes"],
  smrtbot_coupons: ["coupon_code","description","status","raffle_type","winner_child_id","won_at","notes"],
  smrtbot_children: ["child_id","phone","child_name","hebrew_birthday","reminder_time","diamonds","completed_items","active_reminders"],
  smrtbot_diamonds_log: ["phone","child_id","action_type","item_id","diamonds_change","created_at"],
  smrtbot_knowledge_base: ["category","question_pattern","question","keywords","answer","active","notes","sort_order","env","version"],
  smrtbot_auto_messages: ["name","msg_type","wait_time","unit","content","media_url","active","env","version"],
  smrtbot_holidays: ["holiday_name","holiday_group","hebrew_date","start_date","end_date","active","display_emoji","sort_order","notes","env","version"],
  smrtbot_settings: ["key","value","description"],
  smrtbot_scheduled_configs: ["name","active","inactivity_minutes","send_after_minutes","body_text","buttons","image_url","env"],
  smrtbot_questions: ["phone","name","message_text","question_type","bot_reply","matched_type","matched_ids","needs_human","admin_answer","send_reply","reply_sent","reply_sent_at","notes","status","admin_reply","replied_at","replied_by"],
  smrtbot_feedback: ["phone","message","status","admin_note"],
  smrtbot_referral_log: ["referrer_phone","new_phone"],
  smrtbot_publish_batches: ["version","status","note","published_by","tables_json","changes_json"],
};

// source table → target table (bot-scoped; copy intersecting columns + id→legacy_id)
const TABLE_MAP = [
  ["wa_users", "smrtbot_wa_users"],
  ["menu_nodes", "smrtbot_menu_nodes"],
  ["bot_messages_archive", "smrtbot_messages"],
  ["missions_bank", "smrtbot_missions"],
  ["trivia", "smrtbot_trivia"],
  ["raffles", "smrtbot_raffles"],
  ["coupons_bank", "smrtbot_coupons"],
  ["children", "smrtbot_children"],
  ["diamonds_log", "smrtbot_diamonds_log"],
  ["knowledge_base", "smrtbot_knowledge_base"],
  ["auto_messages", "smrtbot_auto_messages"],
  ["holidays", "smrtbot_holidays"],
  ["bot_settings", "smrtbot_settings"],
  ["scheduled_message_configs", "smrtbot_scheduled_configs"],
  ["questions_log", "smrtbot_questions"],
  ["feedback", "smrtbot_feedback"],
  ["referral_log", "smrtbot_referral_log"],
  ["publish_batches", "smrtbot_publish_batches"],
];

const BOOL_COLS = new Set(["active","wa_opted_out","needs_human","send_reply","reply_sent","active_reminders"]);
const JSON_COLS = new Set(["buttons","extra_buttons","state_json","tables_json","changes_json","old_value","new_value"]);

function coerce(col, val) {
  if (val === null) return null;
  if (BOOL_COLS.has(col)) return val === "t" || val === "true";
  if (JSON_COLS.has(col)) { try { return JSON.parse(val); } catch { return val; } }
  return val;
}

// bots: target columns (creds carried; sheet_url + openai_api_key dropped)
const BOT_TARGET = ["name","slug","initials","logo_path","public_phone_number","waba_id","email_footer_text","admin_phones","timezone","active","wa_phone_number_id","wa_access_token","verify_token","test_wa_phone_number_id","test_wa_access_token","test_verify_token","test_phone_display","live_wa_phone_number_id","live_wa_access_token","live_verify_token","live_phone_display"];

function mapRow(srcRow, targetCols, orgId, botUuid) {
  const row = { org_id: orgId, bot_id: botUuid, legacy_id: srcRow.id ? Number(srcRow.id) : null };
  for (const c of targetCols) {
    if (srcRow[c] !== undefined) row[c] = coerce(c, srcRow[c]);
  }
  return row;
}

async function main() {
  const file = arg("dump");
  const orgId = arg("org");
  const dryRun = process.argv.includes("--dry-run");
  if (!file) { console.error("Missing --dump"); process.exit(1); }

  const data = parseDump(readFileSync(file, "utf8"));
  const bots = data.bots ?? [];
  console.log(`[migrate] parsed dump: ${bots.length} bot(s)`);
  for (const [src, dst] of TABLE_MAP) {
    console.log(`  ${src} → ${dst}: ${(data[src] ?? []).length} rows`);
  }

  if (dryRun) {
    console.log("[migrate] dry-run — no DB writes. Sample bot:",
      bots[0] ? { slug: bots[0].slug, name: bots[0].name, legacy_id: bots[0].id } : "none");
    return;
  }

  if (!orgId) { console.error("Missing --org"); process.exit(1); }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1) bots → smrtbot_bots, build legacy int id → new uuid map
  const botIdMap = {};
  for (const b of bots) {
    const insert = { org_id: orgId, legacy_id: Number(b.id) };
    for (const c of BOT_TARGET) if (b[c] !== undefined) insert[c] = coerce(c, b[c]);
    const { data: row, error } = await db.from("smrtbot_bots")
      .upsert(insert, { onConflict: "org_id,slug" }).select("id").single();
    if (error) { console.error(`[migrate] bot ${b.slug} failed:`, error.message); process.exit(1); }
    botIdMap[b.id] = row.id;
    console.log(`[migrate] bot ${b.slug} → ${row.id}`);
  }

  // 2) child tables
  for (const [src, dst] of TABLE_MAP) {
    const rows = (data[src] ?? []).map((r) => mapRow(r, T[dst], orgId, botIdMap[r.bot_id]))
      .filter((r) => r.bot_id);
    let done = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from(dst).insert(rows.slice(i, i + 200));
      if (error) { console.error(`[migrate] ${dst} batch ${i} failed:`, error.message); process.exit(1); }
      done += Math.min(200, rows.length - i);
    }
    console.log(`[migrate] ${dst}: ${done} rows`);
  }
  console.log("[migrate] done");
}

main().catch((e) => { console.error(e); process.exit(1); });
