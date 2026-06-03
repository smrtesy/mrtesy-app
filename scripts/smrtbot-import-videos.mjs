#!/usr/bin/env node
/**
 * smrtBot — video index importer.
 *
 * Loads the "Whatsapp_Bot__Video_Index" CSV into smrtbot_videos. This is the
 * source-of-truth populator now; the same column mapping is the contract the
 * future Maor-website API sync will target, so this stays the single place
 * that maps external video rows → smrtbot_videos.
 *
 * Usage:
 *   node scripts/smrtbot-import-videos.mjs --org <org_uuid> --file <csv> [--bot <bot_uuid>]
 *   node scripts/smrtbot-import-videos.mjs --file <csv> --dry-run     # parse only, no DB
 *
 * Env (when not --dry-run): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { readFileSync } from "node:fs";

// ── minimal RFC-4180 CSV parser (handles quoted fields, "" escapes, newlines)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (c === "\r") {
      // ignore — handled by \n
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// CSV header → smrtbot_videos column
const COLUMN_MAP = {
  "VD ID": "vd_id",
  "VD Internal ID": "vd_internal_id",
  "Video Name": "video_name",
  "Video Number": "video_number",
  "Video Link": "video_link",
  "Full URL": "full_url",
  "Display Link": "display_link",
  "VD Categories": "vd_categories",
  "Bot Main Category": "main_category",
  "Bot Sub Category": "sub_category",
  "Bot Rebbe": "rebbe",
  "VD Holidays": "holidays",
  "Bot Icon": "icon",
  "Bot Icon Source": "icon_source",
  "Search Text": "search_text",
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function rowsToRecords(rows) {
  const header = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    if (raw.every((v) => v.trim() === "")) continue; // skip blank lines
    const rec = {};
    header.forEach((h, i) => {
      const col = COLUMN_MAP[h];
      if (col) rec[col] = (raw[i] ?? "").trim() || null;
    });
    // need at least an id or a name to be a real video
    if (rec.vd_id || rec.video_name) records.push(rec);
  }
  return records;
}

async function main() {
  const file = arg("file");
  const orgId = arg("org");
  const botId = arg("bot");
  const dryRun = process.argv.includes("--dry-run");
  if (!file) { console.error("Missing --file"); process.exit(1); }

  const records = rowsToRecords(parseCsv(readFileSync(file, "utf8")));
  console.log(`[videos] parsed ${records.length} rows from ${file}`);
  console.log("[videos] sample:", JSON.stringify(records[0], null, 2));

  if (dryRun) { console.log("[videos] dry-run — no DB writes"); return; }

  if (!orgId) { console.error("Missing --org for a non-dry-run import"); process.exit(1); }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const now = new Date().toISOString();
  let ok = 0;
  // upsert in batches of 200 on (org_id, vd_id)
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200).map((r) => ({
      ...r,
      org_id: orgId,
      bot_id: botId ?? null,
      synced_at: now,
    }));
    const { error } = await db.from("smrtbot_videos").upsert(batch, { onConflict: "org_id,vd_id" });
    if (error) { console.error(`[videos] batch ${i} failed:`, error.message); process.exit(1); }
    ok += batch.length;
    console.log(`[videos] upserted ${ok}/${records.length}`);
  }
  console.log(`[videos] done — ${ok} rows`);
}

main().catch((e) => { console.error(e); process.exit(1); });
