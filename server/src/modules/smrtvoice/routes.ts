/**
 * smrtVoice — Express routes (v2: folders → scripts → per-script casting).
 *
 * Every route below requires the standard chain:
 *   requireAuth → requireOrg → requireApp("smrtvoice")
 *
 * The unauthenticated webhook endpoint lives in webhook-handler.ts and
 * is mounted separately at app level (before the auth guards).
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp, requireRole } from "../../middleware";
import { emitEvent, notify, notifyError } from "../../lib/platform";
import { simpleCall, parseJsonResponse } from "../../anthropic";
import { getOAuthClient } from "../../services/token-refresh";
import { getDriveClient } from "../../services/drive";

import { getVoiceEngineClient, VoiceEngineError } from "./voice-engine-client";
import type {
  CreateCharacterRequest,
  CreateVoiceProfileRequest,
} from "./types";

// Project (folder) code prefix: 1-3 uppercase letters, e.g. "BR".
const PREFIX_RE = /^[A-Z]{1,3}$/;

/** Human-readable message for a voice-engine error, unwrapping FastAPI `detail`. */
function veMessage(err: unknown): string {
  if (err instanceof VoiceEngineError) {
    const d = err.details as { detail?: unknown } | undefined;
    const detail = d && typeof d === "object" && "detail" in d ? d.detail : undefined;
    if (detail) return typeof detail === "string" ? detail : JSON.stringify(detail);
    return err.message;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

/** Fetch the caller's Google access token (Docs/Drive share one grant). */
async function getGoogleAccessToken(userId: string): Promise<string | null> {
  try {
    const oauthClient = await getOAuthClient(userId, "drive");
    return oauthClient.credentials.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the org pronunciation lexicon shaped for the voice-engine payload:
 * [{word, replacement, language}]. Notation-agnostic — `replacement` is a
 * free-form phonetic string (Hebrew respelling or Latin) sent verbatim.
 * Best-effort: on error we send [] and generation falls back to defaults.
 */
async function loadPronunciation(
  orgId: string,
): Promise<Array<{ word: string; replacement: string; language: string }>> {
  const { data, error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .select("original_word, pronounced_as, language")
    .eq("org_id", orgId)
    // Deterministic order so, if a word carries both a Hebrew and a Latin
    // entry, the variant the engine falls back to is stable (the engine
    // otherwise prefers the one matching each voice's language).
    .order("original_word")
    .order("language");
  if (error) {
    console.warn("[smrtvoice] loadPronunciation failed:", error.message);
    return [];
  }
  return (data ?? [])
    .filter((r: { original_word: string | null; pronounced_as: string | null }) => r.original_word && r.pronounced_as)
    .map((r: { original_word: string; pronounced_as: string; language: string | null }) => ({
      word: r.original_word,
      replacement: r.pronounced_as,
      language: r.language ?? "he",
    }));
}

/**
 * Make a Supabase-Storage-safe object key segment. Storage rejects non-ASCII
 * (e.g. Hebrew) and some punctuation → "InvalidKey". Keep [A-Za-z0-9._-],
 * collapse the rest to "_", and always prefix a short random token so two
 * differently-named-but-same-after-sanitising files never collide/overwrite.
 */
function safeStorageName(name: string, fallback = "audio.wav"): string {
  const cleaned = (name || "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = cleaned || fallback;
  return `${crypto.randomBytes(4).toString("hex")}_${base}`;
}

/** Resolve a Drive folder id from a full folder URL or a bare id. */
function parseFolderId(raw: string): string | null {
  const m = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/) ?? raw.match(/^([a-zA-Z0-9_-]+)$/);
  return m?.[1] ?? null;
}

const router = Router();

// Every smrtVoice route requires auth + active org + smrtvoice enabled for that org.
router.use(requireAuth, requireOrg, requireApp("smrtvoice"));

// ============================================================
// CHARACTERS
// ============================================================

router.get("/voice/characters", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_characters")
    .select("*")
    .eq("org_id", req.org!.id)
    .eq("is_active", true)
    .order("name");

  if (error) {
    await notifyError(req.org!.id, "smrtvoice", {
      title: "Failed to list characters",
      body: error.message,
    });
    return res.status(500).json({ error: error.message });
  }
  res.json({ characters: data ?? [] });
});

router.post(
  "/voice/characters",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const body = req.body as CreateCharacterRequest;
    if (!body?.name?.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    // New characters inherit the org's default Resemble model (resemble-ultra).
    const { data: orgSettings } = await db
      .from("smrtvoice_settings")
      .select("default_resemble_model")
      .eq("org_id", req.org!.id)
      .maybeSingle();

    const { data, error } = await db
      .from("smrtvoice_characters")
      .insert({
        org_id: req.org!.id,
        created_by: req.user!.id,
        name: body.name.trim(),
        display_name: body.display_name?.trim() || null,
        description: body.description ?? null,
        language: body.language ?? "he",
        // All clones are created rapid then upgraded to Ultra; kept for the column.
        voice_type: body.voice_type ?? "rapid",
        age_group: body.age_group ?? null,
        age_years: typeof body.age_years === "number" ? body.age_years : null,
        gender: body.gender ?? null,
        personality_prompt: body.personality_prompt ?? null,
        style_baseline_tags: Array.isArray(body.style_baseline_tags)
          ? body.style_baseline_tags
          : [],
        ...(orgSettings?.default_resemble_model
          ? { resemble_model: orgSettings.default_resemble_model }
          : {}),
      })
      .select()
      .single();

    if (error || !data) {
      await notifyError(req.org!.id, "smrtvoice", {
        title: "Failed to create character",
        body: error?.message ?? "unknown error",
      });
      return res.status(500).json({ error: error?.message ?? "create failed" });
    }

    await emitEvent(req.org!.id, "smrtvoice", "character.created", "character", data.id, {
      name: data.name,
    });
    res.status(201).json({ character: data });
  },
);

router.get("/voice/characters/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_characters")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Character not found" });
  res.json({ character: data });
});

const CHARACTER_UPDATABLE = new Set([
  "name",
  "display_name",
  "description",
  "notes",
  "language",
  "voice_type",
  "age_group",
  "age_years",
  "gender",
  "personality_prompt",
  "style_baseline_tags",
  "resemble_model",
  "default_exaggeration",
  "default_pitch",
  "default_pace",
  "is_active",
]);

router.patch(
  "/voice/characters/:id",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (CHARACTER_UPDATABLE.has(k)) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updatable fields in body" });
    }
    // style_baseline_tags is a jsonb NOT NULL array; coerce non-arrays to []
    // (mirrors the create route) so a stray scalar/null can't break synthesis.
    if ("style_baseline_tags" in updates && !Array.isArray(updates.style_baseline_tags)) {
      updates.style_baseline_tags = [];
    }

    const { data, error } = await db
      .from("smrtvoice_characters")
      .update(updates)
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ character: data });
  },
);

// DELETE /voice/characters/:id — soft-delete (is_active=false) so the row and
// any script casting that references it stay intact; it just leaves the list.
router.delete(
  "/voice/characters/:id",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("smrtvoice_characters")
      .update({ is_active: false })
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Character not found" });
    await emitEvent(req.org!.id, "smrtvoice", "character.deleted", "character", req.params.id, {});
    res.json({ deleted: true });
  },
);

// POST /voice/characters/:id/sample-upload-url — signed URL to upload a sample.
router.post(
  "/voice/characters/:id/sample-upload-url",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const characterId = req.params.id;
    const fileName: string = (req.body?.fileName as string) || "sample.wav";

    const { data: character, error: charErr } = await db
      .from("smrtvoice_characters")
      .select("id")
      .eq("id", characterId)
      .eq("org_id", req.org!.id)
      .maybeSingle();

    if (charErr) return res.status(500).json({ error: charErr.message });
    if (!character) return res.status(404).json({ error: "Character not found" });

    const path = `${req.org!.id}/characters/${characterId}/samples/${safeStorageName(fileName)}`;
    const { data, error } = await db.storage
      .from("smrtvoice-audio")
      .createSignedUploadUrl(path);

    if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
    res.json({ upload_url: data.signedUrl, path: data.path, token: data.token });
  },
);

// POST /voice/characters/:id/clone — body: { sample_path } or { sample_paths: [] }
router.post(
  "/voice/characters/:id/clone",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    // Accept one path (legacy) or many (multi-file upload from the computer).
    const paths: string[] = Array.isArray(req.body?.sample_paths)
      ? req.body.sample_paths.filter(Boolean)
      : req.body?.sample_path
        ? [req.body.sample_path]
        : [];
    if (paths.length === 0) return res.status(400).json({ error: "sample_path(s) required" });

    const { data: character, error: charError } = await db
      .from("smrtvoice_characters")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .maybeSingle();

    if (charError) return res.status(500).json({ error: charError.message });
    if (!character) return res.status(404).json({ error: "Character not found" });

    const signedUrls: string[] = [];
    for (const p of paths) {
      const { data: signed, error: signErr } = await db.storage
        .from("smrtvoice-audio")
        .createSignedUrl(p, 3600);
      if (signErr || !signed) {
        return res.status(500).json({ error: signErr?.message ?? "signing failed" });
      }
      signedUrls.push(signed.signedUrl);
    }

    try {
      const client = getVoiceEngineClient();
      const result = await client.createVoiceClone({
        sample_urls: signedUrls,
        name: character.name,
        language: character.language,
      });

      const { data: updated, error: updateError } = await db
        .from("smrtvoice_characters")
        .update({ resemble_voice_id: result.voice_id, voice_status: "training" })
        .eq("id", req.params.id)
        .select()
        .maybeSingle();
      if (updateError) return res.status(500).json({ error: updateError.message });

      for (const p of paths) {
        const { error: sampleErr } = await db.from("smrtvoice_voice_samples").insert({
          org_id: req.org!.id,
          character_id: character.id,
          created_by: req.user!.id,
          storage_path: p,
          uploaded_to_resemble: true,
          resemble_sample_id: result.voice_id,
        });
        if (sampleErr) console.warn("[smrtvoice] voice_samples insert failed:", sampleErr.message);
      }

      await emitEvent(req.org!.id, "smrtvoice", "character.clone_created", "character", character.id, {
        voice_id: result.voice_id,
        parts: paths.length,
      });
      res.json({ character: updated, status: result.status });
    } catch (err) {
      const message = veMessage(err);
      await notifyError(req.org!.id, "smrtvoice", { title: "Failed to create voice clone", body: message });
      res.status(502).json({ error: message });
    }
  },
);

// GET /voice/characters/:id/voice-status — poll Resemble clone/upgrade readiness.
router.get("/voice/characters/:id/voice-status", async (req: Request, res: Response) => {
  const { data: character, error } = await db
    .from("smrtvoice_characters")
    .select("resemble_voice_id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!character) return res.status(404).json({ error: "Character not found" });
  if (!character.resemble_voice_id) return res.json({ status: "none", voice_uuid: null });

  try {
    const client = getVoiceEngineClient();
    const result = await client.getVoiceStatus(character.resemble_voice_id);
    // Self-heal the stored status so the characters list reflects "ready"
    // without anyone opening the character (Resemble upgrade finishes async).
    // "finished" is Resemble's terminal state for a trained voice (the engine's
    // own clone flow waits for it) — without it a ready voice stays "training".
    const READY = new Set(["ready", "completed", "active", "done", "available", "finished"]);
    if (result.status && READY.has(result.status.toLowerCase())) {
      await db
        .from("smrtvoice_characters")
        .update({ voice_status: "ready" })
        .eq("id", req.params.id)
        .eq("org_id", req.org!.id);
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /voice/google/access-token — hand the browser the caller's own Google
// OAuth token so the Google Drive Picker can render client-side. Short-lived.
router.get("/voice/google/access-token", async (req: Request, res: Response) => {
  const token = await getGoogleAccessToken(req.user!.id);
  if (!token) {
    return res.status(400).json({ error: "Google Drive is not connected. Connect via Settings → Connections." });
  }
  res.json({ access_token: token });
});

// POST /voice/drive/list-folders — folder source for the in-app browser.
// Body: { parent? } drill under a folder (default My Drive root);
//        { q } search folders by name across the user's Drive;
//        { shared: true } list folders shared with the user.
// No Google API key needed (reuses the user's Drive OAuth).
router.post("/voice/drive/list-folders", async (req: Request, res: Response) => {
  const FOLDER = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const q = (req.body?.q ?? "").toString().trim();
  const shared = req.body?.shared === true;

  let query: string;
  if (q) {
    // Escape backslashes then single quotes for the Drive query string.
    const esc = q.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    query = `${FOLDER} and name contains '${esc}'`;
  } else if (shared) {
    query = `${FOLDER} and sharedWithMe = true`;
  } else {
    const parentRaw = (req.body?.parent ?? "").toString().trim();
    const parent = parentRaw ? parseFolderId(parentRaw) : "root";
    if (!parent) return res.status(400).json({ error: "Invalid parent folder" });
    query = `'${parent}' in parents and ${FOLDER}`;
  }

  try {
    const drive = await getDriveClient(req.user!.id);
    const out = await drive.files.list({
      q: query,
      pageSize: 100,
      fields: "files(id, name, webViewLink)",
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const folders = (out.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      url: f.webViewLink ?? `https://drive.google.com/drive/folders/${f.id}`,
    }));
    res.json({ folders });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// POST /voice/drive/list-audio — list audio files in a Drive folder. Body: { folder }.
router.post("/voice/drive/list-audio", async (req: Request, res: Response) => {
  const folderId = parseFolderId((req.body?.folder ?? "").toString().trim());
  if (!folderId) return res.status(400).json({ error: "Invalid Drive folder URL or id" });

  try {
    const drive = await getDriveClient(req.user!.id);
    const out = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: 200,
      fields: "files(id, name, mimeType, size)",
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const AUDIO_RE = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;
    const files = (out.data.files ?? []).filter((f) => {
      const mime = f.mimeType ?? "";
      if (mime.startsWith("application/vnd.google-apps")) return false;
      return mime.startsWith("audio/") || AUDIO_RE.test(f.name ?? "");
    });
    res.json({ files });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// POST /voice/characters/:id/clone-from-drive — body: { file_ids: string[] }
router.post(
  "/voice/characters/:id/clone-from-drive",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const fileIds: string[] = Array.isArray(req.body?.file_ids) ? req.body.file_ids : [];
    if (fileIds.length === 0) return res.status(400).json({ error: "file_ids is required" });

    const { data: character, error: charErr } = await db
      .from("smrtvoice_characters")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .maybeSingle();
    if (charErr) return res.status(500).json({ error: charErr.message });
    if (!character) return res.status(404).json({ error: "Character not found" });

    const MAX_PART_BYTES = 300 * 1024 * 1024; // 300 MB per part

    try {
      const drive = await getDriveClient(req.user!.id);
      const signedUrls: string[] = [];
      const stagedPaths: string[] = [];
      const skipped: string[] = [];

      for (const fileId of fileIds) {
        try {
          const meta = await drive.files.get({
            fileId,
            fields: "name, mimeType, size",
            supportsAllDrives: true,
          });
          const mime = meta.data.mimeType ?? "";
          if (mime.startsWith("application/vnd.google-apps")) {
            skipped.push(meta.data.name ?? fileId);
            continue;
          }
          if (Number(meta.data.size ?? 0) > MAX_PART_BYTES) {
            skipped.push(meta.data.name ?? fileId);
            continue;
          }
          const dl = await drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" },
          );
          const buffer = Buffer.from(dl.data as ArrayBuffer);
          const safeName = (meta.data.name ?? `${fileId}.wav`).replace(/[^\w.\-]+/g, "_");
          const path = `${req.org!.id}/characters/${character.id}/drive/${safeName}`;

          const { error: upErr } = await db.storage
            .from("smrtvoice-audio")
            .upload(path, buffer, { contentType: "audio/wav", upsert: true });
          if (upErr) {
            skipped.push(safeName);
            continue;
          }
          const { data: signed, error: signErr } = await db.storage
            .from("smrtvoice-audio")
            .createSignedUrl(path, 3600);
          if (signErr || !signed) {
            skipped.push(safeName);
            continue;
          }
          signedUrls.push(signed.signedUrl);
          stagedPaths.push(path);
        } catch (fileErr) {
          console.warn(
            `[smrtvoice] drive file ${fileId} skipped:`,
            fileErr instanceof Error ? fileErr.message : fileErr,
          );
          skipped.push(fileId);
        }
      }

      if (signedUrls.length === 0) {
        return res.status(502).json({
          error: "No Drive files could be downloaded (native type, too large, or unreadable)",
          skipped,
        });
      }

      const client = getVoiceEngineClient();
      const result = await client.createVoiceClone({
        sample_urls: signedUrls,
        name: character.name,
        language: character.language,
      });

      for (const path of stagedPaths) {
        const { error: sErr } = await db.from("smrtvoice_voice_samples").insert({
          org_id: req.org!.id,
          character_id: character.id,
          created_by: req.user!.id,
          storage_path: path,
          uploaded_to_resemble: true,
        });
        if (sErr) console.warn("[smrtvoice] voice_samples insert failed:", sErr.message);
      }

      const { data: updated, error: updateError } = await db
        .from("smrtvoice_characters")
        .update({ resemble_voice_id: result.voice_id, voice_status: "training" })
        .eq("id", character.id)
        .select()
        .maybeSingle();
      if (updateError) return res.status(500).json({ error: updateError.message });

      await emitEvent(req.org!.id, "smrtvoice", "character.clone_created", "character", character.id, {
        voice_id: result.voice_id,
        source: "drive",
        parts: signedUrls.length,
      });
      res.json({ character: updated, status: result.status, skipped });
    } catch (err) {
      const message = veMessage(err);
      await notifyError(req.org!.id, "smrtvoice", { title: "Failed to clone voice from Drive", body: message });
      res.status(502).json({ error: message });
    }
  },
);

// ============================================================
// VOICE PROFILES
// ============================================================

router.get("/voice/characters/:id/profiles", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_voice_profiles")
    .select("*")
    .eq("character_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("is_default", { ascending: false })
    .order("profile_name");

  if (error) return res.status(500).json({ error: error.message });
  res.json({ profiles: data ?? [] });
});

router.post("/voice/profiles", async (req: Request, res: Response) => {
  const body = req.body as CreateVoiceProfileRequest;
  if (!body?.character_id || !body?.profile_name) {
    return res.status(400).json({ error: "character_id and profile_name required" });
  }

  const { data, error } = await db
    .from("smrtvoice_voice_profiles")
    .insert({
      org_id: req.org!.id,
      character_id: body.character_id,
      created_by: req.user!.id,
      profile_name: body.profile_name,
      exaggeration: body.exaggeration ?? 0.5,
      pitch: body.pitch ?? 0,
      speaking_pace: body.speaking_pace ?? "normal",
      resemble_prompt: body.resemble_prompt ?? null,
      context: body.context ?? null,
      is_default: body.is_default ?? false,
    })
    .select()
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message ?? "create failed" });
  res.status(201).json({ profile: data });
});

// ============================================================
// PROJECTS (folders)
// ============================================================

router.get("/voice/projects", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const projects = data ?? [];

  // Attach each folder's scripts so the list can render a direct-open button
  // per script (one round trip instead of N-per-folder).
  const { data: scripts, error: scriptsErr } = await db
    .from("smrtvoice_scripts")
    .select("id, project_id, seq, code, name, status")
    .eq("org_id", req.org!.id)
    .order("seq");

  if (scriptsErr) return res.status(500).json({ error: scriptsErr.message });

  const byProject = new Map<string, typeof scripts>();
  for (const s of scripts ?? []) {
    const list = byProject.get(s.project_id) ?? [];
    list.push(s);
    byProject.set(s.project_id, list);
  }

  res.json({
    projects: projects.map((p) => ({ ...p, scripts: byProject.get(p.id) ?? [] })),
  });
});

// Create a project (folder): { name, description?, code_prefix }.
router.post("/voice/projects", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body?.name?.trim()) return res.status(400).json({ error: "name is required" });

  const prefix = (body.code_prefix ?? "").toString().trim().toUpperCase() || null;
  if (prefix && !PREFIX_RE.test(prefix)) {
    return res.status(400).json({ error: "Invalid code prefix — use 1-3 letters (e.g. BR)" });
  }

  const { data, error } = await db
    .from("smrtvoice_projects")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      name: body.name.trim(),
      description: body.description ?? null,
      code_prefix: prefix,
      language: body.language ?? "he",
      status: "draft",
    })
    .select()
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: `A project with prefix "${prefix}" already exists` });
    }
    await notifyError(req.org!.id, "smrtvoice", { title: "Failed to create project", body: error?.message ?? "create failed" });
    return res.status(500).json({ error: error?.message ?? "create failed" });
  }

  await emitEvent(req.org!.id, "smrtvoice", "project.created", "project", data.id, { name: data.name });
  res.status(201).json({ project: data });
});

// POST /voice/drive/list-docs — list Google Docs in a Drive folder. Body: { folder }.
router.post("/voice/drive/list-docs", async (req: Request, res: Response) => {
  const folderId = parseFolderId((req.body?.folder ?? "").toString().trim());
  if (!folderId) return res.status(400).json({ error: "Invalid Drive folder URL or id" });

  try {
    const drive = await getDriveClient(req.user!.id);
    const out = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document'`,
      pageSize: 200,
      fields: "files(id, name, webViewLink)",
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = (out.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}/edit`,
    }));
    res.json({ files });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// POST /voice/doc-tabs — list a Google Doc's tabs. Body: { google_doc_url }.
router.post("/voice/doc-tabs", async (req: Request, res: Response) => {
  const url: string = req.body?.google_doc_url ?? "";
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: "Invalid Google Doc URL" });

  const token = await getGoogleAccessToken(req.user!.id);
  if (!token) {
    return res.status(400).json({ error: "Google Drive is not connected. Connect via Settings → Connections." });
  }
  try {
    const client = getVoiceEngineClient();
    res.json(await client.listDocumentTabs(match[1], token));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

const PROJECT_UPDATABLE = new Set([
  "name",
  "description",
  "code_prefix",
  "language",
  "gdrive_target_folder_id",
  "gdrive_target_folder_url",
]);

router.patch("/voice/projects/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (PROJECT_UPDATABLE.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields in body" });
  }
  if ("code_prefix" in updates) {
    const raw = updates.code_prefix;
    if (raw === null || raw === "") updates.code_prefix = null;
    else {
      const p = String(raw).trim().toUpperCase();
      if (!PREFIX_RE.test(p)) return res.status(400).json({ error: "Invalid code prefix — use 1-3 letters (e.g. BR)" });
      updates.code_prefix = p;
    }
  }

  const { data, error } = await db
    .from("smrtvoice_projects")
    .update(updates)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That code prefix is already in use" });
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ project: data });
});

router.get("/voice/projects/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Project not found" });
  res.json({ project: data });
});

// DELETE /voice/projects/:id — remove a folder (scripts, lines, jobs cascade).
router.delete("/voice/projects/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_projects")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select("id")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Project not found" });
  await emitEvent(req.org!.id, "smrtvoice", "project.deleted", "project", req.params.id, {});
  res.json({ deleted: true });
});

// ============================================================
// SCRIPTS (programs inside a folder)
// ============================================================

router.get("/voice/projects/:id/scripts", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_scripts")
    .select("*")
    .eq("project_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("seq");

  if (error) return res.status(500).json({ error: error.message });
  res.json({ scripts: data ?? [] });
});

// Create a script under a folder: { name?, google_doc_url, google_doc_tab_id?, google_doc_tab_title? }.
// Auto-numbers: code = {project.code_prefix}{seq}.
router.post("/voice/projects/:id/scripts", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body?.google_doc_url) return res.status(400).json({ error: "google_doc_url is required" });
  const match = String(body.google_doc_url).match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: "Invalid Google Doc URL" });

  const { data: project, error: projErr } = await db
    .from("smrtvoice_projects")
    .select("id, code_prefix, language")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (projErr) return res.status(500).json({ error: projErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.code_prefix) {
    return res.status(400).json({ error: "Set a code prefix on the project first (e.g. BR)" });
  }

  const { data: last } = await db
    .from("smrtvoice_scripts")
    .select("seq")
    .eq("project_id", project.id)
    .order("seq", { ascending: false })
    .limit(1);
  const seq = (last?.[0]?.seq ?? 0) + 1;
  const code = `${project.code_prefix}${seq}`;

  const { data, error } = await db
    .from("smrtvoice_scripts")
    .insert({
      org_id: req.org!.id,
      project_id: project.id,
      created_by: req.user!.id,
      seq,
      code,
      name: body.name?.trim() || null,
      language: body.language ?? project.language ?? "he",
      google_doc_id: match[1],
      google_doc_url: body.google_doc_url,
      google_doc_tab_id: body.google_doc_tab_id ?? null,
      google_doc_tab_title: body.google_doc_tab_title ?? null,
      generation_mode: body.generation_mode ?? "tts",
      status: "draft",
    })
    .select()
    .single();

  if (error || !data) {
    // Two scripts added to the same folder at once race on MAX(seq)+1 and
    // collide on UNIQUE(project_id,seq)/(org_id,code). Surface a friendly
    // retry instead of a raw 500 — the next attempt picks the next seq.
    if (error?.code === "23505") {
      return res.status(409).json({ error: "A script was just added — please try again" });
    }
    return res.status(500).json({ error: error?.message ?? "create failed" });
  }
  await emitEvent(req.org!.id, "smrtvoice", "script.created", "script", data.id, { code });
  res.status(201).json({ script: data });
});

router.get("/voice/scripts/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_scripts")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Script not found" });
  res.json({ script: data });
});

const SCRIPT_UPDATABLE = new Set([
  "name",
  "google_doc_url",
  "google_doc_id",
  "google_doc_tab_id",
  "google_doc_tab_title",
  "generation_mode",
  "input_recording_path",
]);

router.patch("/voice/scripts/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (SCRIPT_UPDATABLE.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields in body" });

  const { data, error } = await db
    .from("smrtvoice_scripts")
    .update(updates)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ script: data });
});

router.delete("/voice/scripts/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_scripts")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select("id")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Script not found" });
  res.json({ deleted: true });
});

// Parse a script's Google Doc → populate the speaker list (casting), inheriting
// the project's first script's casting by speaker name.
router.post("/voice/scripts/:id/parse", async (req: Request, res: Response) => {
  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (scriptErr) return res.status(500).json({ error: scriptErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });
  if (!script.google_doc_id) return res.status(400).json({ error: "Script has no Google Doc" });

  const token = await getGoogleAccessToken(req.user!.id);
  if (!token) {
    return res.status(400).json({ error: "Google Drive is not connected. Connect via Settings → Connections." });
  }

  try {
    const client = getVoiceEngineClient();
    const result = await client.parseScript(script.google_doc_id, token, {
      id: script.google_doc_tab_id,
      title: script.google_doc_tab_title,
    });

    // Inherit casting from the project's first script (lowest seq, not this one).
    const inherited = new Map<string, { character_id: string | null; resemble_voice_id: string | null }>();
    const { data: firstScript } = await db
      .from("smrtvoice_scripts")
      .select("id")
      .eq("project_id", script.project_id)
      .neq("id", script.id)
      .order("seq")
      .limit(1);
    if (firstScript?.[0]) {
      const { data: firstCast } = await db
        .from("smrtvoice_script_speakers")
        .select("speaker_name, character_id, resemble_voice_id")
        .eq("script_id", firstScript[0].id);
      for (const c of firstCast ?? []) {
        inherited.set(c.speaker_name, {
          character_id: c.character_id,
          resemble_voice_id: c.resemble_voice_id,
        });
      }
    }

    // Only add speakers not already cast on this script.
    const { data: existing } = await db
      .from("smrtvoice_script_speakers")
      .select("speaker_name")
      .eq("script_id", script.id);
    const existingSet = new Set((existing ?? []).map((s: { speaker_name: string }) => s.speaker_name));

    const rows = (result.speakers ?? [])
      .filter((sp: string) => !existingSet.has(sp))
      .map((sp: string) => ({
        org_id: req.org!.id,
        script_id: script.id,
        speaker_name: sp,
        character_id: inherited.get(sp)?.character_id ?? null,
        resemble_voice_id: inherited.get(sp)?.resemble_voice_id ?? null,
      }));
    if (rows.length > 0) {
      const { error: insErr } = await db.from("smrtvoice_script_speakers").insert(rows);
      if (insErr) console.warn("[smrtvoice] script_speakers insert failed:", insErr.message);
    }

    const { error: updateErr } = await db
      .from("smrtvoice_scripts")
      .update({
        status: "parsed",
        total_lines: result.total_lines,
        script_imported_at: new Date().toISOString(),
      })
      .eq("id", script.id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({ parsed: result });
  } catch (err) {
    let message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof VoiceEngineError && err.details) {
      const d = err.details as { detail?: unknown };
      const detail = d && typeof d === "object" && "detail" in d ? d.detail : err.details;
      if (detail) message += ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    }
    await notifyError(req.org!.id, "smrtvoice", { title: "Failed to parse script", body: message });
    res.status(502).json({ error: message });
  }
});

// GET/PATCH the per-script casting (speaker_name → character or stock voice).
router.get("/voice/scripts/:id/speakers", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_script_speakers")
    .select("*")
    .eq("script_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("speaker_name");
  if (error) return res.status(500).json({ error: error.message });

  // Attach each speaker's line count (how many lines that speaker has).
  const { data: lines } = await db
    .from("smrtvoice_lines")
    .select("speaker_name")
    .eq("script_id", req.params.id)
    .eq("org_id", req.org!.id);
  const counts = new Map<string, number>();
  for (const l of lines ?? []) {
    counts.set(l.speaker_name, (counts.get(l.speaker_name) ?? 0) + 1);
  }
  const speakers = (data ?? []).map((s: { speaker_name: string }) => ({
    ...s,
    line_count: counts.get(s.speaker_name) ?? 0,
  }));
  res.json({ speakers });
});

router.patch("/voice/scripts/:id/speakers", async (req: Request, res: Response) => {
  const list: Array<{
    speaker_name: string;
    character_id?: string | null;
    resemble_voice_id?: string | null;
    skip?: boolean;
  }> = Array.isArray(req.body?.speakers) ? req.body.speakers : [];
  if (list.length === 0) return res.status(400).json({ error: "speakers array is required" });

  const rows = list
    .filter((s) => s.speaker_name)
    .map((s) => ({
      org_id: req.org!.id,
      script_id: req.params.id,
      speaker_name: s.speaker_name,
      // A skipped speaker carries no voice — its lines won't be generated.
      character_id: s.skip ? null : (s.character_id ?? null),
      resemble_voice_id: s.skip ? null : (s.resemble_voice_id ?? null),
      skip: s.skip ?? false,
    }));

  const { data, error } = await db
    .from("smrtvoice_script_speakers")
    .upsert(rows, { onConflict: "script_id,speaker_name" })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ speakers: data ?? [] });
});

// POST /voice/scripts/:id/generate — build the speaker_map from casting and queue.
router.post("/voice/scripts/:id/generate", async (req: Request, res: Response) => {
  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (scriptErr) return res.status(500).json({ error: scriptErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });
  if (script.status === "queued" || script.status === "processing") {
    return res.status(409).json({ error: "Script is already being processed" });
  }

  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("*")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  // Monthly budget check (sum of script costs this month).
  if (settings) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: monthCosts } = await db
      .from("smrtvoice_scripts")
      .select("total_cost_usd")
      .eq("org_id", req.org!.id)
      .gte("created_at", monthStart.toISOString());
    const totalThisMonth = (monthCosts ?? []).reduce(
      (sum: number, s: { total_cost_usd: number | null }) => sum + (s.total_cost_usd ?? 0),
      0,
    );
    if (totalThisMonth >= settings.monthly_budget_usd * settings.budget_block_threshold) {
      return res.status(402).json({ error: "monthly_budget_exceeded", current: totalThisMonth, budget: settings.monthly_budget_usd });
    }
  }

  // Build the speaker_map from casting.
  const { data: cast, error: castErr } = await db
    .from("smrtvoice_script_speakers")
    .select("speaker_name, character_id, resemble_voice_id, skip")
    .eq("script_id", script.id);
  if (castErr) return res.status(500).json({ error: castErr.message });

  const charIds = (cast ?? []).map((c) => c.character_id).filter(Boolean) as string[];
  const charMap = new Map<string, { resemble_voice_id: string | null; resemble_model: string | null; language: string; name: string; description: string | null }>();
  if (charIds.length > 0) {
    const { data: chars } = await db
      .from("smrtvoice_characters")
      .select("id, name, description, resemble_voice_id, resemble_model, language")
      .in("id", charIds)
      .eq("org_id", req.org!.id);
    for (const c of chars ?? []) charMap.set(c.id, c);
  }

  const speakerMap: Record<string, { resemble_voice_id: string; model?: string | null; language?: string; character_id?: string | null; character_name?: string | null; description?: string | null }> = {};
  for (const c of cast ?? []) {
    if (c.character_id && charMap.get(c.character_id)?.resemble_voice_id) {
      const ch = charMap.get(c.character_id)!;
      speakerMap[c.speaker_name] = {
        resemble_voice_id: ch.resemble_voice_id!,
        model: ch.resemble_model,
        language: ch.language,
        character_id: c.character_id,
        character_name: ch.name,
        description: ch.description,
      };
    } else if (c.resemble_voice_id) {
      speakerMap[c.speaker_name] = { resemble_voice_id: c.resemble_voice_id, language: script.language ?? "he" };
    }
  }
  if (Object.keys(speakerMap).length === 0) {
    return res.status(400).json({ error: "Cast at least one speaker to a voice before generating" });
  }

  // Every speaker must be decided: either cast to a usable voice, or explicitly
  // skipped. Block only the *undecided* ones (not cast, not skipped) so the user
  // doesn't accidentally drop lines — while still allowing "cast one, skip the
  // rest" to preview a single voice. Skipped speakers' lines aren't generated.
  const undecided = (cast ?? [])
    .filter((c) => !speakerMap[c.speaker_name] && !c.skip)
    .map((c) => c.speaker_name);
  if (undecided.length > 0) {
    return res.status(400).json({
      error: `These speakers need a voice or "skip": ${undecided.join(", ")}`,
      speakers: undecided,
    });
  }

  try {
    let inputAudioUrl: string | undefined;
    if (script.generation_mode === "sts" && script.input_recording_path) {
      const { data: urlData } = await db.storage
        .from("smrtvoice-audio")
        .createSignedUrl(script.input_recording_path, 3600);
      inputAudioUrl = urlData?.signedUrl;
    }

    const token = await getGoogleAccessToken(req.user!.id);
    if (!token && script.google_doc_id) {
      return res.status(400).json({ error: "Google Drive is not connected. Connect via Settings → Connections before generating." });
    }

    const client = getVoiceEngineClient();
    const engineJob = await client.createJob({
      org_id: req.org!.id,
      project_id: script.project_id,
      script_id: script.id,
      user_id: req.user!.id,
      job_type: "generate_audio",
      adapter: settings?.default_adapter ?? "resemble",
      mode: script.generation_mode,
      google_doc_id: script.google_doc_id ?? undefined,
      google_oauth_token: token ?? undefined,
      google_doc_tab_id: script.google_doc_tab_id ?? undefined,
      google_doc_tab_title: script.google_doc_tab_title ?? undefined,
      input_audio_url: inputAudioUrl,
      llm_model: settings?.default_llm_model ?? undefined,
      code: script.code,
      speaker_map: speakerMap,
      pronunciation: await loadPronunciation(req.org!.id),
      postprocess_enabled: settings?.postprocess_enabled ?? undefined,
      postprocess_compress: settings?.postprocess_compress ?? undefined,
      postprocess_speed: settings?.postprocess_speed ?? undefined,
      postprocess_normalize: settings?.postprocess_normalize ?? undefined,
      postprocess_target_db: settings?.postprocess_target_db ?? undefined,
    });

    const { data: job, error: jobErr } = await db
      .from("smrtvoice_jobs")
      .insert({
        org_id: req.org!.id,
        project_id: script.project_id,
        script_id: script.id,
        created_by: req.user!.id,
        job_type: "generate_audio",
        adapter: settings?.default_adapter ?? "resemble",
        voice_engine_job_id: engineJob.job_id,
        status: "queued",
      })
      .select()
      .single();
    if (jobErr || !job) return res.status(500).json({ error: jobErr?.message ?? "job insert failed" });

    const { error: queueFlipErr } = await db.from("smrtvoice_scripts").update({ status: "queued" }).eq("id", script.id);
    if (queueFlipErr) console.error("[smrtvoice] script queued-status update failed:", queueFlipErr);
    await emitEvent(req.org!.id, "smrtvoice", "job.queued", "job", job.id, {
      script_id: script.id,
      estimated_seconds: engineJob.estimated_seconds,
    });
    res.json({ job, estimated_seconds: engineJob.estimated_seconds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await notifyError(req.org!.id, "smrtvoice", { title: "Failed to start audio generation", body: message });
    res.status(502).json({ error: message });
  }
});

// POST /voice/scripts/:id/sync — reconcile a script that's stuck in
// queued/processing because its job.completed / job.failed webhook never
// arrived. The voice-engine worker writes counts/cost/stage directly to the
// script row, so a dropped completion webhook leaves ONLY the terminal status
// unset. We poll the engine for the job's real status and flip the script
// (and fire the completion notification) accordingly. Counts/cost are left
// untouched — the worker owns those.
router.post("/voice/scripts/:id/sync", async (req: Request, res: Response) => {
  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .select("id, org_id, project_id, created_by, code, name, status")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (scriptErr) return res.status(500).json({ error: scriptErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });

  // Only queued/processing scripts can be stuck; anything terminal is left alone.
  if (script.status !== "queued" && script.status !== "processing") {
    return res.json({ script_status: script.status, reconciled: false });
  }

  // Only the full-generation job can leave a script stuck in queued/processing;
  // a redo (regenerate_line) never changes the script status, so scope to it.
  const { data: job } = await db
    .from("smrtvoice_jobs")
    .select("id, voice_engine_job_id, job_type")
    .eq("script_id", script.id)
    .eq("org_id", req.org!.id)
    .eq("job_type", "generate_audio")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job?.voice_engine_job_id) {
    return res.json({ script_status: script.status, reconciled: false });
  }

  let engine;
  try {
    engine = await getVoiceEngineClient().getJob(job.voice_engine_job_id);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }

  if (engine.status === "completed") {
    const { error: jobDoneErr } = await db
      .from("smrtvoice_jobs")
      .update({ status: "completed", progress: 100 })
      .eq("id", job.id);
    if (jobDoneErr) console.error("[smrtvoice] sync job completed-status update failed:", jobDoneErr);
    // Abort before notifying if the status flip fails — otherwise the row stays
    // queued and the next mount re-syncs and double-notifies the user.
    const { error: flipErr } = await db
      .from("smrtvoice_scripts")
      .update({ status: "audio_ready", audio_ready_at: new Date().toISOString() })
      .eq("id", script.id);
    if (flipErr) return res.status(500).json({ error: flipErr.message });
    const label = script.name || script.code;
    await notify(script.org_id, script.created_by, {
      app_slug: "smrtvoice",
      type: "success",
      title: `הקול ל-${label} מוכן`,
      body: `${engine.lines_completed ?? 0} שורות הסתיימו בהצלחה.`,
      link: `/voice/scripts/${script.id}`,
      entity_type: "script",
      entity_id: script.id,
    });
    return res.json({ script_status: "audio_ready", reconciled: true });
  }

  if (engine.status === "failed") {
    const { error: jobFailErr } = await db
      .from("smrtvoice_jobs")
      .update({
        status: "failed",
        error_message: engine.error_message ?? "Unknown error",
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    if (jobFailErr) console.error("[smrtvoice] sync job failed-status update failed:", jobFailErr);
    const { error: flipErr } = await db
      .from("smrtvoice_scripts")
      .update({ status: "failed" })
      .eq("id", script.id);
    if (flipErr) return res.status(500).json({ error: flipErr.message });
    await notifyError(script.org_id, "smrtvoice", {
      title: `הייצור ל-${script.name || script.code} נכשל`,
      body: engine.error_message ?? "Unknown error",
      link: `/voice/scripts/${script.id}`,
    });
    return res.json({ script_status: "failed", reconciled: true });
  }

  // Still queued/running on the engine — nothing to reconcile yet.
  res.json({ script_status: script.status, reconciled: false });
});

// STS input-recording upload URL for a script.
router.post("/voice/scripts/:id/upload-url", async (req: Request, res: Response) => {
  const scriptId = req.params.id;
  const fileName: string = (req.body?.fileName as string) || "recording.wav";
  const { data: script, error: sErr } = await db
    .from("smrtvoice_scripts")
    .select("id")
    .eq("id", scriptId)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });

  const path = `${req.org!.id}/scripts/${scriptId}/input/${safeStorageName(fileName, "recording.wav")}`;
  const { data, error } = await db.storage.from("smrtvoice-audio").createSignedUploadUrl(path);
  if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
  res.json({ upload_url: data.signedUrl, path: data.path, token: data.token });
});

// POST /voice/scripts/:id/archive — save the script's completed audio to Drive.
router.post("/voice/scripts/:id/archive", async (req: Request, res: Response) => {
  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (scriptErr) return res.status(500).json({ error: scriptErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });

  const { data: project } = await db
    .from("smrtvoice_projects")
    .select("gdrive_target_folder_id")
    .eq("id", script.project_id)
    .maybeSingle();
  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("gdrive_archive_folder_id")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  const rootFolderId = project?.gdrive_target_folder_id || settings?.gdrive_archive_folder_id;
  if (!rootFolderId) {
    return res.status(400).json({ error: "No Drive folder configured. Set an archive folder in Voice settings or a target folder on the project." });
  }

  const { data: lines, error: linesErr } = await db
    .from("smrtvoice_lines")
    .select("id, line_number, output_audio_path")
    .eq("script_id", script.id)
    .eq("org_id", req.org!.id)
    .eq("status", "completed")
    .not("output_audio_path", "is", null)
    .is("archived_at", null)
    .order("line_number");
  if (linesErr) return res.status(500).json({ error: linesErr.message });
  if (!lines || lines.length === 0) return res.status(400).json({ error: "No completed audio to archive yet" });

  // Archive the SET of good takes per line (with the note in the filename) so a
  // multi-take line comes down as every version the user marked; a line with no
  // good take falls back to its single current output. take_number (1 = oldest)
  // matches the UI label.
  const { data: allTakes, error: allTakesErr } = await db
    .from("smrtvoice_line_takes")
    .select("line_id, output_audio_path, note, approved, created_at")
    .eq("script_id", script.id)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: true });
  // Non-fatal: on error we fall back to each line's single current output.
  if (allTakesErr) console.warn("[smrtvoice] archive take query failed:", allTakesErr.message);
  const goodByLine = new Map<string, Array<{ path: string; note: string | null; n: number }>>();
  const rankByLine = new Map<string, number>();
  for (const t of (allTakes ?? []) as Array<{ line_id: string; output_audio_path: string | null; note: string | null; approved: boolean }>) {
    const n = (rankByLine.get(t.line_id) ?? 0) + 1;
    rankByLine.set(t.line_id, n);
    if (t.approved && t.output_audio_path) {
      const arr = goodByLine.get(t.line_id) ?? [];
      arr.push({ path: t.output_audio_path, note: t.note, n });
      goodByLine.set(t.line_id, arr);
    }
  }
  // Strip characters illegal in a filename; keep Hebrew/spaces so the note stays
  // readable. Empty note → no suffix.
  const noteSuffix = (note: string | null): string => {
    // eslint-disable-next-line no-control-regex
    const clean = (note ?? "").replace(/[/\\:*?"<>|\x00-\x1f]/g, "").trim();
    return clean ? `_${clean}` : "";
  };

  try {
    const drive = await getDriveClient(req.user!.id);
    let folderId = script.archive_gdrive_folder_id as string | null;
    let folderUrl = script.archive_gdrive_folder_url as string | null;
    if (!folderId) {
      const folder = await drive.files.create({
        requestBody: { name: script.code, mimeType: "application/vnd.google-apps.folder", parents: [rootFolderId] },
        fields: "id, webViewLink",
        supportsAllDrives: true,
      });
      folderId = folder.data.id ?? null;
      folderUrl = folder.data.webViewLink ?? null;
    }
    if (!folderId) return res.status(502).json({ error: "Failed to create Drive folder" });

    const { error: archivingErr } = await db.from("smrtvoice_scripts").update({ status: "archiving" }).eq("id", script.id);
    if (archivingErr) console.error("[smrtvoice] script archiving-status update failed:", archivingErr);

    let uploaded = 0;
    let skipped = 0;
    for (const line of lines as Array<{ id: string; line_number: number; output_audio_path: string }>) {
      const base = `${script.code}_${String(line.line_number).padStart(3, "0")}`;
      const good = goodByLine.get(line.id) ?? [];
      // Good takes if any (each named with its take number + note); else the
      // single current output.
      const files = good.length > 0
        ? good.map((g) => ({ path: g.path, name: `${base}_v${g.n}${noteSuffix(g.note)}.wav` }))
        : [{ path: line.output_audio_path, name: `${base}.wav` }];
      for (const f of files) {
        const { data: blob, error: dlErr } = await db.storage.from("smrtvoice-audio").download(f.path);
        if (dlErr || !blob) {
          skipped += 1;
          continue;
        }
        const buffer = Buffer.from(await blob.arrayBuffer());
        await drive.files.create({
          requestBody: { name: f.name, parents: [folderId] },
          media: { mimeType: "audio/wav", body: Readable.from(buffer) },
          fields: "id",
          supportsAllDrives: true,
        });
        uploaded += 1;
      }
    }

    if (uploaded === 0) {
      const { error: revertErr } = await db.from("smrtvoice_scripts").update({ status: "audio_ready" }).eq("id", script.id);
      if (revertErr) console.error("[smrtvoice] script status revert after failed archive failed:", revertErr);
      return res.status(502).json({ error: "Failed to upload any audio to Drive", skipped });
    }

    const fullyArchived = skipped === 0;
    const { data: updated, error: updErr } = await db
      .from("smrtvoice_scripts")
      .update({
        status: fullyArchived ? "archived" : "audio_ready",
        archive_gdrive_folder_id: folderId,
        archive_gdrive_folder_url: folderUrl,
        archived_at: fullyArchived ? new Date().toISOString() : null,
      })
      .eq("id", script.id)
      .select()
      .maybeSingle();
    if (updErr) return res.status(500).json({ error: updErr.message });

    await emitEvent(req.org!.id, "smrtvoice", "script.archived", "script", script.id, { folder_url: folderUrl, uploaded, skipped });
    res.json({ script: updated, folder_url: folderUrl, uploaded, skipped });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await notifyError(req.org!.id, "smrtvoice", { title: "Failed to archive to Drive", body: message });
    res.status(502).json({ error: message });
  }
});

// ============================================================
// LINES (per script)
// ============================================================

router.get("/voice/scripts/:id/lines", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_lines")
    .select("*")
    .eq("script_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("line_number");
  if (error) return res.status(500).json({ error: error.message });

  // Attach each line's take count (how many renders it has in history) so the
  // list can show a "N versions" badge without a per-line round trip.
  const { data: takeRows, error: takeErr } = await db
    .from("smrtvoice_line_takes")
    .select("line_id, approved")
    .eq("script_id", req.params.id)
    .eq("org_id", req.org!.id);
  if (takeErr) console.warn("[smrtvoice] take_count query failed:", takeErr.message);
  const takeCounts = new Map<string, number>();
  const approvedCounts = new Map<string, number>();
  for (const t of takeRows ?? []) {
    takeCounts.set(t.line_id, (takeCounts.get(t.line_id) ?? 0) + 1);
    if (t.approved) approvedCounts.set(t.line_id, (approvedCounts.get(t.line_id) ?? 0) + 1);
  }
  // approved_take_count drives the "good recording" indicator, so it always
  // agrees with what's actually marked in the takes list. If the takes query
  // failed, fall back to the persisted line.approved column so the indicator
  // doesn't vanish for every line on a transient error.
  const lines = (data ?? []).map((l: { id: string; approved?: boolean }) => ({
    ...l,
    take_count: takeCounts.get(l.id) ?? 0,
    approved_take_count: takeErr ? (l.approved ? 1 : 0) : (approvedCounts.get(l.id) ?? 0),
  }));
  res.json({ lines });
});

// POST /voice/scripts/:id/lines/bulk — archive (soft, reversible), unarchive,
// or permanently delete a set of lines. Delete cascades to each line's takes
// (FK) and best-effort removes their audio from storage.
router.post(
  "/voice/scripts/:id/lines/bulk",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const action = req.body?.action as string;
    const ids: string[] = Array.isArray(req.body?.line_ids)
      ? req.body.line_ids.filter(Boolean)
      : [];
    if (!["archive", "unarchive", "delete"].includes(action)) {
      return res.status(400).json({ error: "action must be archive | unarchive | delete" });
    }
    if (ids.length === 0) return res.status(400).json({ error: "line_ids required" });

    if (action === "archive" || action === "unarchive") {
      const { error } = await db
        .from("smrtvoice_lines")
        .update({ archived_at: action === "archive" ? new Date().toISOString() : null })
        .eq("script_id", req.params.id)
        .eq("org_id", req.org!.id)
        .in("id", ids);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, action, count: ids.length });
    }

    // delete: resolve the org/script-scoped rows first (so we only touch this
    // caller's lines), gather audio paths, clean storage, then delete the rows.
    const { data: delLines, error: linesErr } = await db
      .from("smrtvoice_lines")
      .select("id, output_audio_path")
      .eq("script_id", req.params.id)
      .eq("org_id", req.org!.id)
      .in("id", ids);
    if (linesErr) return res.status(500).json({ error: linesErr.message });
    const lineIds = (delLines ?? []).map((l) => l.id);
    if (lineIds.length === 0) return res.json({ ok: true, action, count: 0 });

    const { data: takeRows } = await db
      .from("smrtvoice_line_takes")
      .select("output_audio_path")
      .eq("org_id", req.org!.id)
      .in("line_id", lineIds);

    const paths = [
      ...(delLines ?? []).map((l) => l.output_audio_path),
      ...(takeRows ?? []).map((t) => t.output_audio_path),
    ].filter((p): p is string => !!p);
    if (paths.length > 0) {
      const { error: rmErr } = await db.storage.from("smrtvoice-audio").remove(paths);
      // Non-fatal: orphaned audio is harmless; deleting the rows is what matters.
      if (rmErr) console.warn("[smrtvoice] bulk-delete storage cleanup failed:", rmErr.message);
    }

    const { error: delErr } = await db
      .from("smrtvoice_lines")
      .delete()
      .eq("script_id", req.params.id)
      .eq("org_id", req.org!.id)
      .in("id", lineIds);
    if (delErr) return res.status(500).json({ error: delErr.message });
    res.json({ ok: true, action, count: lineIds.length });
  },
);

const LINE_UPDATABLE = new Set([
  "text_clean",
  "text_for_tts",
  "tts_body",
  "tags",
  "emotion",
  "emotion_source",
  "character_id",
  "final_exaggeration",
  "final_pitch",
  "final_pace",
  "status",
  "approved",
]);

router.patch("/voice/lines/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (LINE_UPDATABLE.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields in body" });

  const { data, error } = await db
    .from("smrtvoice_lines")
    .update(updates)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ line: data });
});

// Re-render a set of line numbers in a script via voice-engine + track the job.
async function queueRegeneration(
  req: Request,
  res: Response,
  script: {
    id: string;
    project_id: string;
    code: string;
    language?: string | null;
    generation_mode?: "sts" | "tts";
    input_recording_path?: string | null;
  },
  lineNumbers: number[],
  // Verbatim per-line text edits ("send again with edited text"). Each is sent
  // to voice-engine as a line_override and synthesized exactly as given.
  lineOverrides: Array<{ line_number: number; text_for_tts: string }> = [],
  // Line numbers to re-run through the LLM (fresh emotion + tone tags).
  reprocessLineNumbers: number[] = [],
) {
  if (lineNumbers.length === 0) return res.status(400).json({ error: "No lines to regenerate" });

  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("default_adapter, default_llm_model, postprocess_enabled, postprocess_compress, postprocess_speed, postprocess_normalize, postprocess_target_db")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  // Rebuild the casting map so regenerated lines use the current voices.
  const { data: cast } = await db
    .from("smrtvoice_script_speakers")
    .select("speaker_name, character_id, resemble_voice_id")
    .eq("script_id", script.id);
  const charIds = (cast ?? []).map((c) => c.character_id).filter(Boolean) as string[];
  const charMap = new Map<string, { resemble_voice_id: string | null; resemble_model: string | null; language: string; name: string; description: string | null }>();
  if (charIds.length > 0) {
    const { data: chars } = await db
      .from("smrtvoice_characters")
      .select("id, name, description, resemble_voice_id, resemble_model, language")
      .in("id", charIds)
      .eq("org_id", req.org!.id);
    for (const c of chars ?? []) charMap.set(c.id, c);
  }
  const speakerMap: Record<string, { resemble_voice_id: string; model?: string | null; language?: string; character_id?: string | null; character_name?: string | null; description?: string | null }> = {};
  for (const c of cast ?? []) {
    if (c.character_id && charMap.get(c.character_id)?.resemble_voice_id) {
      const ch = charMap.get(c.character_id)!;
      speakerMap[c.speaker_name] = { resemble_voice_id: ch.resemble_voice_id!, model: ch.resemble_model, language: ch.language, character_id: c.character_id, character_name: ch.name, description: ch.description };
    } else if (c.resemble_voice_id) {
      speakerMap[c.speaker_name] = { resemble_voice_id: c.resemble_voice_id, language: script.language ?? "he" };
    }
  }

  // Preserve the script's generation mode — regenerating a line in an STS
  // script must re-render via speech-to-speech (with the input recording),
  // not fall back to TTS and produce a mismatched take.
  const mode = script.generation_mode ?? "tts";
  let inputAudioUrl: string | undefined;
  if (mode === "sts" && script.input_recording_path) {
    const { data: urlData } = await db.storage
      .from("smrtvoice-audio")
      .createSignedUrl(script.input_recording_path, 3600);
    inputAudioUrl = urlData?.signedUrl;
  }

  try {
    const client = getVoiceEngineClient();
    const engineJob = await client.createJob({
      org_id: req.org!.id,
      project_id: script.project_id,
      script_id: script.id,
      user_id: req.user!.id,
      job_type: "regenerate_line",
      adapter: settings?.default_adapter ?? "resemble",
      mode,
      input_audio_url: inputAudioUrl,
      llm_model: settings?.default_llm_model ?? undefined,
      code: script.code,
      speaker_map: speakerMap,
      line_numbers: lineNumbers,
      pronunciation: await loadPronunciation(req.org!.id),
      line_overrides: lineOverrides,
      reprocess_line_numbers: reprocessLineNumbers,
      postprocess_enabled: settings?.postprocess_enabled ?? undefined,
      postprocess_compress: settings?.postprocess_compress ?? undefined,
      postprocess_speed: settings?.postprocess_speed ?? undefined,
      postprocess_normalize: settings?.postprocess_normalize ?? undefined,
      postprocess_target_db: settings?.postprocess_target_db ?? undefined,
    });

    const { data: job, error: jobErr } = await db
      .from("smrtvoice_jobs")
      .insert({
        org_id: req.org!.id,
        project_id: script.project_id,
        script_id: script.id,
        created_by: req.user!.id,
        job_type: "regenerate_line",
        adapter: settings?.default_adapter ?? "resemble",
        voice_engine_job_id: engineJob.job_id,
        status: "queued",
      })
      .select()
      .single();
    if (jobErr || !job) return res.status(500).json({ error: jobErr?.message ?? "job insert failed" });

    const { error: flipErr } = await db
      .from("smrtvoice_lines")
      .update({ status: "processing", redo_requested: false, redone_at: new Date().toISOString() })
      .eq("script_id", script.id)
      .eq("org_id", req.org!.id)
      .in("line_number", lineNumbers);
    if (flipErr) console.warn("[smrtvoice] failed to flip redo lines to processing:", flipErr.message);

    res.json({ job, line_numbers: lineNumbers });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

async function loadScriptForLine(req: Request, lineId: string) {
  const { data: line } = await db
    .from("smrtvoice_lines")
    .select("script_id, line_number")
    .eq("id", lineId)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (!line) return null;
  const { data: script } = await db
    .from("smrtvoice_scripts")
    .select("id, project_id, code, language, generation_mode, input_recording_path")
    .eq("id", line.script_id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  return script ? { script, line } : null;
}

router.post("/voice/lines/:id/regenerate", async (req: Request, res: Response) => {
  const found = await loadScriptForLine(req, req.params.id);
  if (!found) return res.status(404).json({ error: "Line not found" });

  // Optional "send again with edited text": the client passes the exact text
  // to speak (prefilled from tts_body). `reprocess` re-runs the LLM for fresh
  // emotion/tone tags instead of sending the text verbatim.
  const editedText =
    typeof req.body?.text_for_tts === "string" ? req.body.text_for_tts.trim() : "";
  const reprocess = req.body?.reprocess === true;
  const lineNo = found.line.line_number;

  // The edited text is always forwarded: verbatim when not reprocessing, or as
  // the LLM's input when reprocessing.
  const overrides = editedText ? [{ line_number: lineNo, text_for_tts: editedText }] : [];
  const reprocessLineNumbers = reprocess ? [lineNo] : [];

  // Only persist a verbatim edit when NOT reprocessing — if the LLM re-runs it
  // will produce (and the engine will persist) fresh text/tags, so persisting
  // a verbatim body + empty tags here would be wrong.
  if (editedText && !reprocess) {
    // Mirror the engine's override behaviour: the edited text becomes the body
    // verbatim (tone tags are baked into it), so clear the separate tags.
    const { error: saveErr } = await db
      .from("smrtvoice_lines")
      .update({ text_for_tts: editedText, tts_body: editedText, tags: [] })
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id);
    if (saveErr) return res.status(500).json({ error: saveErr.message });
  }
  await queueRegeneration(req, res, found.script, [lineNo], overrides, reprocessLineNumbers);
});

router.post("/voice/lines/:id/redo", async (req: Request, res: Response) => {
  const reason: string = (req.body?.reason ?? "").toString().trim();
  const instructions: string = (req.body?.instructions ?? "").toString().trim();
  const { data, error } = await db
    .from("smrtvoice_lines")
    .update({ redo_requested: true, redo_reason: reason || null, redo_instructions: instructions || null })
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ line: data });
});

router.delete("/voice/lines/:id/redo", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_lines")
    .update({ redo_requested: false, redo_reason: null, redo_instructions: null })
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ line: data });
});

router.post("/voice/scripts/:id/regenerate-redos", async (req: Request, res: Response) => {
  const { data: script, error: scriptErr } = await db
    .from("smrtvoice_scripts")
    .select("id, project_id, code, language, generation_mode, input_recording_path")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (scriptErr) return res.status(500).json({ error: scriptErr.message });
  if (!script) return res.status(404).json({ error: "Script not found" });

  const { data: lines, error: linesErr } = await db
    .from("smrtvoice_lines")
    .select("line_number")
    .eq("script_id", script.id)
    .eq("org_id", req.org!.id)
    .eq("redo_requested", true)
    .order("line_number");
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  const lineNumbers = (lines ?? []).map((l: { line_number: number }) => l.line_number);
  if (lineNumbers.length === 0) return res.status(400).json({ error: "No lines are marked for redo" });
  await queueRegeneration(req, res, script, lineNumbers);
});

router.get("/voice/lines/:id/audio-url", async (req: Request, res: Response) => {
  const { data: line, error: lineErr } = await db
    .from("smrtvoice_lines")
    .select("output_audio_path")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line || !line.output_audio_path) return res.status(404).json({ error: "Audio not found" });

  const { data, error } = await db.storage.from("smrtvoice-audio").createSignedUrl(line.output_audio_path, 3600);
  if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
  res.json({ audio_url: data.signedUrl });
});

// ============================================================
// LINE TAKES (render history — every take is kept, never overwritten)
// ============================================================

router.get("/voice/lines/:id/takes", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_line_takes")
    .select("*")
    .eq("line_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ takes: data ?? [] });
});

// PATCH /voice/takes/:id — mark a take as "good" (⭐) and/or jot a note.
// `approved` is MULTI-select per line: several takes can be marked good (e.g. to
// take part of each in editing). The line's outer indicator, sequential play,
// download and archive all operate on the SET of good takes (see
// /voice/lines/:id/selection). Marking never touches output_audio_path — the
// engine owns that (the latest render, used only as a fallback), so a regenerate
// never steals the user's selection. `note` is independent.
router.patch("/voice/takes/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const hasApproved = typeof body.approved === "boolean";
  const hasNote = typeof body.note === "string" || body.note === null;
  if (!hasApproved && !hasNote) {
    return res.status(400).json({ error: "No updatable fields in body" });
  }

  const { data: take, error: takeErr } = await db
    .from("smrtvoice_line_takes")
    .select("id, line_id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (takeErr) return res.status(500).json({ error: takeErr.message });
  if (!take) return res.status(404).json({ error: "Take not found" });

  if (hasNote) {
    const { error } = await db
      .from("smrtvoice_line_takes")
      .update({ note: (body.note as string | null) || null })
      .eq("id", take.id)
      .eq("org_id", req.org!.id);
    if (error) return res.status(500).json({ error: error.message });
  }

  if (hasApproved) {
    // Toggle just THIS take (multi-select — no sibling clearing).
    const { error: setErr } = await db
      .from("smrtvoice_line_takes")
      .update({ approved: body.approved })
      .eq("id", take.id)
      .eq("org_id", req.org!.id);
    if (setErr) return res.status(500).json({ error: setErr.message });

    // Keep the line's outer indicator in sync: lit iff any good take remains.
    const { count, error: countErr } = await db
      .from("smrtvoice_line_takes")
      .select("id", { count: "exact", head: true })
      .eq("line_id", take.line_id)
      .eq("org_id", req.org!.id)
      .eq("approved", true);
    if (countErr) return res.status(500).json({ error: countErr.message });

    const { error: lineErr } = await db
      .from("smrtvoice_lines")
      .update({ approved: (count ?? 0) > 0 })
      .eq("id", take.line_id)
      .eq("org_id", req.org!.id);
    if (lineErr) return res.status(500).json({ error: lineErr.message });
  }

  const { data: updated, error: readErr } = await db
    .from("smrtvoice_line_takes")
    .select()
    .eq("id", take.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  res.json({ take: updated });
});

router.get("/voice/takes/:id/audio-url", async (req: Request, res: Response) => {
  const { data: take, error } = await db
    .from("smrtvoice_line_takes")
    .select("output_audio_path")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!take || !take.output_audio_path) return res.status(404).json({ error: "Take not found" });

  const { data, error: signErr } = await db.storage
    .from("smrtvoice-audio")
    .createSignedUrl(take.output_audio_path, 3600);
  if (signErr || !data) return res.status(500).json({ error: signErr?.message ?? "signing failed" });
  res.json({ audio_url: data.signedUrl });
});

// GET /voice/lines/:id/selection — the line's "good" takes (⭐), each with a
// signed URL, its chronological take number and note, for sequential play and
// multi-download. When no take is marked good, falls back to the line's current
// single output (one item, fallback:true). take_number matches the "Take N"
// label in the UI (1 = oldest).
router.get("/voice/lines/:id/selection", async (req: Request, res: Response) => {
  const { data: line, error: lineErr } = await db
    .from("smrtvoice_lines")
    .select("id, output_audio_path")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const { data: takeRows, error: takesErr } = await db
    .from("smrtvoice_line_takes")
    .select("id, approved, note, output_audio_path, created_at")
    .eq("line_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: true });
  if (takesErr) return res.status(500).json({ error: takesErr.message });

  const sign = async (path: string): Promise<string | null> => {
    const { data } = await db.storage.from("smrtvoice-audio").createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  };

  const ranked = (takeRows ?? []).map((t, i) => ({ ...t, take_number: i + 1 }));
  const good = ranked.filter((t) => t.approved && t.output_audio_path);

  const items: Array<{ take_id: string | null; url: string; take_number: number | null; note: string | null }> = [];
  if (good.length > 0) {
    for (const t of good) {
      const url = await sign(t.output_audio_path);
      if (url) items.push({ take_id: t.id, url, take_number: t.take_number, note: t.note });
    }
    // Only if at least one good take signed; otherwise fall through to the
    // line's single output so play/download still has something.
    if (items.length > 0) return res.json({ items, fallback: false });
  }
  if (line.output_audio_path) {
    const url = await sign(line.output_audio_path);
    if (url) items.push({ take_id: null, url, take_number: null, note: null });
  }
  res.json({ items, fallback: true });
});

// ============================================================
// VOICE LIBRARY (Resemble account)
// ============================================================

router.get("/voice/resemble/account", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  try {
    const client = getVoiceEngineClient();
    res.json(await client.getResembleAccount(req.query.refresh === "true"));
  } catch (err) {
    res.status(502).json({ error: veMessage(err) });
  }
});

router.get("/voice/resemble/voices", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  try {
    const client = getVoiceEngineClient();
    const { voices } = await client.listVoices(req.query.refresh === "true");
    const liveIds = new Set((voices ?? []).map((v) => String(v.uuid)));

    // Self-heal: null any character voice link whose Resemble voice no longer
    // exists (e.g. deleted directly on the Resemble dashboard). Keeps the
    // Characters screen honest without a manual unlink.
    const { data: linked } = await db
      .from("smrtvoice_characters")
      .select("id, resemble_voice_id")
      .eq("org_id", req.org!.id)
      .not("resemble_voice_id", "is", null);
    const dangling = (linked ?? [])
      .filter((c: { resemble_voice_id: string }) => !liveIds.has(c.resemble_voice_id))
      .map((c: { id: string }) => c.id);
    if (dangling.length > 0) {
      const { error: unlinkErr } = await db.from("smrtvoice_characters").update({ resemble_voice_id: null }).in("id", dangling);
      if (unlinkErr) console.error("[smrtvoice] dangling voice unlink failed:", unlinkErr);
    }

    // Which voices already have a stored preview for this org.
    const { data: previews } = await db
      .from("smrtvoice_voice_previews")
      .select("resemble_voice_id")
      .eq("org_id", req.org!.id);
    const hasPreview = new Set((previews ?? []).map((p: { resemble_voice_id: string }) => p.resemble_voice_id));

    // Custom per-org display names.
    const { data: labels } = await db
      .from("smrtvoice_voice_labels")
      .select("resemble_voice_id, display_name")
      .eq("org_id", req.org!.id);
    const labelMap = new Map(
      (labels ?? []).map((l: { resemble_voice_id: string; display_name: string }) => [l.resemble_voice_id, l.display_name]),
    );

    res.json({
      voices: (voices ?? []).map((v) => ({
        ...v,
        has_preview: hasPreview.has(String(v.uuid)),
        display_name: labelMap.get(String(v.uuid)) ?? null,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: veMessage(err) });
  }
});

router.delete("/voice/resemble/voices/:uuid", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const uuid = req.params.uuid;
  try {
    const client = getVoiceEngineClient();
    const result = await client.deleteVoice(uuid);
    // Unlink any characters + drop the stored preview.
    const { error: unlinkErr } = await db.from("smrtvoice_characters").update({ resemble_voice_id: null }).eq("org_id", req.org!.id).eq("resemble_voice_id", uuid);
    if (unlinkErr) console.error("[smrtvoice] character unlink on voice delete failed:", unlinkErr);
    const { error: previewDelErr } = await db.from("smrtvoice_voice_previews").delete().eq("org_id", req.org!.id).eq("resemble_voice_id", uuid);
    if (previewDelErr) console.error("[smrtvoice] preview delete on voice delete failed:", previewDelErr);
    res.json({ deleted: result.deleted });
  } catch (err) {
    res.status(502).json({ error: veMessage(err) });
  }
});

// PATCH /voice/resemble/voices/:uuid/label — set/clear a custom display name.
router.patch("/voice/resemble/voices/:uuid/label", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const uuid = req.params.uuid;
  const name = (req.body?.display_name ?? "").toString().trim();
  if (!name) {
    const { error } = await db
      .from("smrtvoice_voice_labels")
      .delete()
      .eq("org_id", req.org!.id)
      .eq("resemble_voice_id", uuid);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ display_name: null });
  }
  const { error } = await db
    .from("smrtvoice_voice_labels")
    .upsert(
      { org_id: req.org!.id, resemble_voice_id: uuid, display_name: name },
      { onConflict: "org_id,resemble_voice_id" },
    );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ display_name: name });
});

// POST /voice/resemble/voices/:uuid/sample — synthesize + store a preview.
router.post("/voice/resemble/voices/:uuid/sample", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const uuid = req.params.uuid;
  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("sample_text")
    .eq("org_id", req.org!.id)
    .maybeSingle();
  const text = (req.body?.text as string)?.trim() || settings?.sample_text || "שלום, זו דוגמה קצרה לקול.";

  try {
    const client = getVoiceEngineClient();
    const sample = await client.generateSample(uuid, text);
    // Download the synthesized clip and store it so replays are free.
    const resp = await fetch(sample.audio_url);
    if (!resp.ok) return res.status(502).json({ error: `Failed to fetch sample: ${resp.status}` });
    const buffer = Buffer.from(await resp.arrayBuffer());
    const path = `${req.org!.id}/previews/${uuid}.wav`;
    const { error: upErr } = await db.storage.from("smrtvoice-audio").upload(path, buffer, { contentType: "audio/wav", upsert: true });
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { error: pErr } = await db
      .from("smrtvoice_voice_previews")
      .upsert({ org_id: req.org!.id, resemble_voice_id: uuid, storage_path: path, sample_text: text }, { onConflict: "org_id,resemble_voice_id" });
    if (pErr) return res.status(500).json({ error: pErr.message });

    res.json({ ok: true, cost: sample.cost });
  } catch (err) {
    res.status(502).json({ error: veMessage(err) });
  }
});

router.get("/voice/resemble/voices/:uuid/sample", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const { data: preview, error } = await db
    .from("smrtvoice_voice_previews")
    .select("storage_path")
    .eq("org_id", req.org!.id)
    .eq("resemble_voice_id", req.params.uuid)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!preview) return res.status(404).json({ error: "No sample yet" });

  const { data, error: signErr } = await db.storage.from("smrtvoice-audio").createSignedUrl(preview.storage_path, 3600);
  if (signErr || !data) return res.status(500).json({ error: signErr?.message ?? "signing failed" });
  res.json({ audio_url: data.signedUrl });
});

// ============================================================
// SETTINGS
// ============================================================

router.get("/voice/settings", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_settings")
    .select("*")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    const { data: created, error: insertErr } = await db
      .from("smrtvoice_settings")
      .insert({ org_id: req.org!.id })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    return res.json({ settings: created });
  }
  res.json({ settings: data });
});

// GET /voice/budget — this month's spend vs the org budget. Sums cost from
// `smrtvoice_scripts` (v2 writes cost there, not to projects), matching the
// authoritative check in the generate route.
router.get("/voice/budget", async (req: Request, res: Response) => {
  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("monthly_budget_usd, budget_warning_threshold, budget_block_threshold")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: monthCosts, error: costErr } = await db
    .from("smrtvoice_scripts")
    .select("total_cost_usd")
    .eq("org_id", req.org!.id)
    .gte("created_at", monthStart.toISOString());
  if (costErr) return res.status(500).json({ error: costErr.message });

  const used = (monthCosts ?? []).reduce(
    (sum: number, s: { total_cost_usd: number | null }) => sum + (s.total_cost_usd ?? 0),
    0,
  );
  res.json({
    used,
    budget: settings?.monthly_budget_usd ?? 0,
    warning_threshold: settings?.budget_warning_threshold ?? 0.8,
    block_threshold: settings?.budget_block_threshold ?? 1.0,
  });
});

const SETTINGS_UPDATABLE = new Set([
  "monthly_budget_usd",
  "budget_warning_threshold",
  "budget_block_threshold",
  "default_adapter",
  "default_resemble_model",
  "default_llm_model",
  "archive_after_days",
  "archive_auto_enabled",
  "gdrive_archive_folder_id",
  "gdrive_archive_folder_url",
  "project_folder_template",
  "audio_file_template",
  "postprocess_enabled",
  "postprocess_compress",
  "postprocess_speed",
  "postprocess_normalize",
  "postprocess_target_db",
  "sample_text",
  "gdrive_archive_folder_id",
  "gdrive_archive_folder_url",
  "notify_on_completion",
  "notify_on_budget_warn",
  "notify_via_whatsapp",
]);

router.patch(
  "/voice/settings",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (SETTINGS_UPDATABLE.has(k)) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields in body" });

    const { data, error } = await db
      .from("smrtvoice_settings")
      .update(updates)
      .eq("org_id", req.org!.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data });
  },
);

// ============================================================
// PRONUNCIATION LEXICON
// ============================================================

router.get("/voice/lexicon", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("original_word");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data ?? [] });
});

// `language` marks the notation of `pronounced_as`: 'he' (Hebrew respelling)
// or 'en' (Latin transliteration). Same word can carry one entry per language.
const LEXICON_LANGUAGES = new Set(["he", "en"]);

router.post("/voice/lexicon", async (req: Request, res: Response) => {
  const { original_word, pronounced_as, category, notes } = req.body ?? {};
  const language = (req.body?.language ?? "he").toString();
  if (!original_word || !pronounced_as) {
    return res.status(400).json({ error: "original_word and pronounced_as required" });
  }
  if (!LEXICON_LANGUAGES.has(language)) {
    return res.status(400).json({ error: "language must be 'he' or 'en'" });
  }
  const { data, error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      original_word: String(original_word).trim(),
      pronounced_as: String(pronounced_as).trim(),
      language,
      category: category ?? "general",
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error || !data) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: "That word already has an entry for this language" });
    }
    return res.status(500).json({ error: error?.message ?? "create failed" });
  }
  res.status(201).json({ entry: data });
});

const LEXICON_UPDATABLE = new Set([
  "original_word",
  "pronounced_as",
  "language",
  "category",
  "notes",
]);

router.patch("/voice/lexicon/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (LEXICON_UPDATABLE.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields in body" });
  }
  if ("language" in updates && !LEXICON_LANGUAGES.has(String(updates.language))) {
    return res.status(400).json({ error: "language must be 'he' or 'en'" });
  }
  for (const k of ["original_word", "pronounced_as"] as const) {
    if (k in updates) updates[k] = String(updates[k]).trim();
  }

  const { data, error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .update(updates)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "That word already has an entry for this language" });
    }
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ entry: data });
});

router.delete("/voice/lexicon/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// POST /voice/pronunciation/suggest — AI phonetic-respelling suggestions for a
// word/phrase. Returns Hebrew respellings AND Latin transliterations as
// separate chip lists; the UI drops a chosen chip into the edit/lexicon field.
router.post("/voice/pronunciation/suggest", async (req: Request, res: Response) => {
  const word = (req.body?.word ?? req.body?.text ?? "").toString().trim();
  if (!word) return res.status(400).json({ error: "word is required" });
  if (word.length > 200) return res.status(400).json({ error: "text too long (max 200 chars)" });

  const system = `You help a Hebrew children's TV studio fix mispronunciations on Resemble "resemble-ultra" TTS. Ultra has NO working phoneme/IPA/<sub> support and niqqud HARMS it — the ONLY fix is respelling the text so it READS correctly.

Given a Hebrew word or short phrase, propose respellings that steer the engine to the intended pronunciation:
- "hebrew": up to 3 alternative HEBREW spellings using plain letters only (NO niqqud / vowel points) — e.g. double a letter, add a mater lectionis (א/ו/י), split a cluster.
- "latin": up to 3 Latin/English transliterations that read correctly when spoken.
Keep each suggestion short and directly speakable. Never add niqqud. Do not explain.
Return ONLY JSON: {"hebrew": string[], "latin": string[]}`;

  try {
    const { content } = await simpleCall(
      "haiku",
      system,
      `Word/phrase: ${word}`,
      400,
      { component: "smrtvoice.pronounce_suggest", userId: req.user!.id },
    );
    const parsed = parseJsonResponse<{ hebrew?: string[]; latin?: string[] }>(content);
    const clean = (arr?: string[]) =>
      Array.from(new Set((arr ?? []).map((s) => String(s).trim()).filter(Boolean))).slice(0, 3);
    res.json({ hebrew: clean(parsed?.hebrew), latin: clean(parsed?.latin) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

export default router;
