/**
 * smrtVoice — Express routes.
 *
 * Every route below requires the standard chain:
 *   requireAuth → requireOrg → requireApp("smrtvoice")
 *
 * The unauthenticated webhook endpoint lives in webhook-handler.ts and
 * is mounted separately at app level (before the auth guards).
 */

import { Readable } from "node:stream";

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp, requireRole } from "../../middleware";
import { emitEvent, notifyError } from "../../lib/platform";
import { getOAuthClient } from "../../services/token-refresh";
import { getDriveClient } from "../../services/drive";

import { getVoiceEngineClient, VoiceEngineError } from "./voice-engine-client";
import type {
  CreateCharacterRequest,
  CreateProjectRequest,
  CreateVoiceProfileRequest,
} from "./types";

// Program code: 1-2 uppercase letters + digits, e.g. "BR1". Matches the
// CHECK constraint in 20260630120000_smrtvoice_studio.sql.
const CODE_RE = /^[A-Z]{1,2}[0-9]+$/;

/** Fetch the caller's Google access token (Docs/Drive share one grant). */
async function getGoogleAccessToken(userId: string): Promise<string | null> {
  try {
    const oauthClient = await getOAuthClient(userId, "drive");
    return oauthClient.credentials.access_token ?? null;
  } catch {
    return null;
  }
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

    // New characters inherit the org's default Resemble model. The column
    // has a DB default of 'chatterbox', but the org setting (editable in
    // /voice/settings) takes precedence so a studio can switch its default
    // model once and have every new character pick it up.
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
        voice_type: body.voice_type ?? "pro",
        age_group: body.age_group ?? null,
        gender: body.gender ?? null,
        personality_prompt: body.personality_prompt ?? null,
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

    await emitEvent(
      req.org!.id,
      "smrtvoice",
      "character.created",
      "character",
      data.id,
      { name: data.name },
    );

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

// Whitelisted columns for PATCH — prevents a client from overwriting
// org_id / created_by / resemble_voice_id (the last is set only by the
// clone flow, not by free-form edits).
const CHARACTER_UPDATABLE = new Set([
  "name",
  "display_name",
  "description",
  "notes",
  "language",
  "voice_type",
  "age_group",
  "gender",
  "personality_prompt",
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

// POST /voice/characters/:id/sample-upload-url — get a signed URL to upload
// a voice sample directly to Supabase Storage. Returns { upload_url, path }.
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

    const path = `${req.org!.id}/characters/${characterId}/samples/${fileName}`;

    const { data, error } = await db.storage
      .from("smrtvoice-audio")
      .createSignedUploadUrl(path);

    if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
    res.json({ upload_url: data.signedUrl, path: data.path, token: data.token });
  },
);

// POST /voice/characters/:id/clone — body: { sample_path, voice_type? }
// `sample_path` is the storage path returned from /sample-upload-url after
// the client uploads. We turn it into a signed download URL and hand it to
// voice-engine, which downloads + multipart-uploads to Resemble.
router.post(
  "/voice/characters/:id/clone",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { sample_path, voice_type } = req.body ?? {};
    if (!sample_path) {
      return res.status(400).json({ error: "sample_path is required" });
    }

    const { data: character, error: charError } = await db
      .from("smrtvoice_characters")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .maybeSingle();

    if (charError) return res.status(500).json({ error: charError.message });
    if (!character) return res.status(404).json({ error: "Character not found" });

    // Sign the sample so voice-engine (Python service, no Supabase auth) can fetch it.
    const { data: signed, error: signErr } = await db.storage
      .from("smrtvoice-audio")
      .createSignedUrl(sample_path, 3600);

    if (signErr || !signed) {
      return res.status(500).json({ error: signErr?.message ?? "signing failed" });
    }

    try {
      const client = getVoiceEngineClient();
      const result = await client.createVoiceClone({
        sample_url: signed.signedUrl,
        name: character.name,
        voice_type: voice_type ?? "pro",
        language: character.language,
      });

      const { data: updated, error: updateError } = await db
        .from("smrtvoice_characters")
        .update({ resemble_voice_id: result.voice_id })
        .eq("id", req.params.id)
        .select()
        .maybeSingle();

      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }

      // Persist the sample row for traceability. Non-fatal: log if the row
      // can't be written but don't fail the clone.
      const { error: sampleErr } = await db.from("smrtvoice_voice_samples").insert({
        org_id: req.org!.id,
        character_id: character.id,
        created_by: req.user!.id,
        storage_path: sample_path,
        uploaded_to_resemble: true,
        resemble_sample_id: result.voice_id,
      });
      if (sampleErr) {
        console.warn("[smrtvoice] voice_samples insert failed:", sampleErr.message);
      }

      await emitEvent(
        req.org!.id,
        "smrtvoice",
        "character.clone_created",
        "character",
        character.id,
        { voice_id: result.voice_id },
      );

      res.json({ character: updated, status: result.status });
    } catch (err) {
      const message =
        err instanceof VoiceEngineError
          ? `Voice Engine: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Unknown error";
      await notifyError(req.org!.id, "smrtvoice", {
        title: "Failed to create voice clone",
        body: message,
      });
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
  if (!character.resemble_voice_id) {
    return res.json({ status: "none", voice_uuid: null });
  }

  try {
    const client = getVoiceEngineClient();
    const status = await client.getVoiceStatus(character.resemble_voice_id);
    res.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// POST /voice/drive/list-audio — list audio files in a Google Drive folder,
// so the user can pick which recordings to clone from. Body: { folder }
// (a Drive folder URL or a bare folder id).
router.post("/voice/drive/list-audio", async (req: Request, res: Response) => {
  const raw: string = (req.body?.folder ?? "").toString().trim();
  if (!raw) return res.status(400).json({ error: "folder is required" });
  // Accept a full Drive folder URL or a bare id.
  const m = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/) ?? raw.match(/^([a-zA-Z0-9_-]+)$/);
  const folderId = m?.[1];
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
      // Google-native items (Docs/Sheets/shortcuts) can't be downloaded via
      // alt=media even if named ".wav", so exclude them from the picker.
      if (mime.startsWith("application/vnd.google-apps")) return false;
      return mime.startsWith("audio/") || AUDIO_RE.test(f.name ?? "");
    });
    res.json({ files });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// POST /voice/characters/:id/clone-from-drive — download the chosen Drive files,
// stage them in storage, and create an Ultra clone (each part is split into
// <=12s clips server-side). Body: { file_ids: string[] }.
router.post(
  "/voice/characters/:id/clone-from-drive",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const fileIds: string[] = Array.isArray(req.body?.file_ids) ? req.body.file_ids : [];
    if (fileIds.length === 0) {
      return res.status(400).json({ error: "file_ids is required" });
    }

    const { data: character, error: charErr } = await db
      .from("smrtvoice_characters")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.org!.id)
      .maybeSingle();
    if (charErr) return res.status(500).json({ error: charErr.message });
    if (!character) return res.status(404).json({ error: "Character not found" });

    // Guard against buffering a huge file into memory (whole-file download).
    const MAX_PART_BYTES = 300 * 1024 * 1024; // 300 MB per part

    try {
      const drive = await getDriveClient(req.user!.id);
      const signedUrls: string[] = [];
      const stagedPaths: string[] = [];
      const skipped: string[] = [];

      for (const fileId of fileIds) {
        // Stage each Drive file in Supabase storage so voice-engine (no Google
        // auth) can fetch it via a signed URL. A single bad file (native type,
        // too large, transient error) is skipped, not fatal to the batch.
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

      // Record staged samples only AFTER the clone succeeds, so a mid-loop
      // failure doesn't leave orphan rows. Non-fatal if the ledger write fails.
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
        .update({ resemble_voice_id: result.voice_id })
        .eq("id", character.id)
        .select()
        .maybeSingle();
      if (updateError) return res.status(500).json({ error: updateError.message });

      await emitEvent(
        req.org!.id,
        "smrtvoice",
        "character.clone_created",
        "character",
        character.id,
        { voice_id: result.voice_id, source: "drive", parts: signedUrls.length },
      );

      res.json({ character: updated, status: result.status, skipped });
    } catch (err) {
      const message =
        err instanceof VoiceEngineError
          ? `Voice Engine: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Unknown error";
      await notifyError(req.org!.id, "smrtvoice", {
        title: "Failed to clone voice from Drive",
        body: message,
      });
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
// PROJECTS
// ============================================================

router.get("/voice/projects", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ projects: data ?? [] });
});

router.post("/voice/projects", async (req: Request, res: Response) => {
  const body = req.body as CreateProjectRequest;
  if (!body?.name?.trim() || !body?.google_doc_url) {
    return res.status(400).json({ error: "name and google_doc_url required" });
  }

  const match = body.google_doc_url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    return res.status(400).json({ error: "Invalid Google Doc URL" });
  }
  const googleDocId = match[1];

  const code = body.code?.trim().toUpperCase() || null;
  if (code && !CODE_RE.test(code)) {
    return res.status(400).json({
      error: "Invalid code — use 1-2 letters followed by a number (e.g. BR1)",
    });
  }

  const { data, error } = await db
    .from("smrtvoice_projects")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      name: body.name.trim(),
      description: body.description ?? null,
      code,
      language: body.language,
      google_doc_id: googleDocId,
      google_doc_url: body.google_doc_url,
      google_doc_tab_id: body.google_doc_tab_id ?? null,
      google_doc_tab_title: body.google_doc_tab_title ?? null,
      // resemble-ultra is a TTS recipe; default to TTS unless told otherwise.
      generation_mode: body.generation_mode ?? "tts",
      status: "draft",
    })
    .select()
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: `A project with code "${code}" already exists` });
    }
    await notifyError(req.org!.id, "smrtvoice", {
      title: "Failed to create project",
      body: error?.message ?? "create failed",
    });
    return res.status(500).json({ error: error?.message ?? "create failed" });
  }

  await emitEvent(
    req.org!.id,
    "smrtvoice",
    "project.created",
    "project",
    data.id,
    { name: data.name, language: data.language },
  );

  res.status(201).json({ project: data });
});

// POST /voice/doc-tabs — list the tabs of a Google Doc (for the language-tab
// picker in the create-project form). Body: { google_doc_url }.
router.post("/voice/doc-tabs", async (req: Request, res: Response) => {
  const url: string = req.body?.google_doc_url ?? "";
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return res.status(400).json({ error: "Invalid Google Doc URL" });

  const token = await getGoogleAccessToken(req.user!.id);
  if (!token) {
    return res.status(400).json({
      error: "Google Drive is not connected. Connect via Settings → Connections.",
    });
  }

  try {
    const client = getVoiceEngineClient();
    const result = await client.listDocumentTabs(match[1], token);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// PATCH /voice/projects/:id — whitelisted field updates.
const PROJECT_UPDATABLE = new Set([
  "name",
  "description",
  "code",
  "language",
  "google_doc_url",
  "google_doc_id",
  "google_doc_tab_id",
  "google_doc_tab_title",
  "generation_mode",
  "input_recording_path",
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

  // Normalize + validate code the same way as create.
  if ("code" in updates) {
    const raw = updates.code;
    if (raw === null || raw === "") {
      updates.code = null;
    } else {
      const code = String(raw).trim().toUpperCase();
      if (!CODE_RE.test(code)) {
        return res.status(400).json({
          error: "Invalid code — use 1-2 letters followed by a number (e.g. BR1)",
        });
      }
      updates.code = code;
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
    if (error.code === "23505") {
      return res.status(409).json({ error: "A project with that code already exists" });
    }
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

router.post("/voice/projects/:id/parse", async (req: Request, res: Response) => {
  const { data: project, error: projectErr } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (projectErr) return res.status(500).json({ error: projectErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.google_doc_id) return res.status(400).json({ error: "Project has no Google Doc" });

  try {
    // voice-engine needs the user's Google access token to fetch the doc.
    let googleAccessToken: string | undefined;
    try {
      const oauthClient = await getOAuthClient(req.user!.id, "drive");
      googleAccessToken = oauthClient.credentials.access_token ?? undefined;
    } catch {
      return res.status(400).json({
        error: "Google Drive is not connected for this user. Connect via Settings → Connections.",
      });
    }
    if (!googleAccessToken) {
      return res.status(400).json({ error: "Failed to obtain Google access token" });
    }

    const client = getVoiceEngineClient();
    const result = await client.parseScript(project.google_doc_id, googleAccessToken, {
      id: project.google_doc_tab_id,
      title: project.google_doc_tab_title,
    });

    const { error: updateErr } = await db
      .from("smrtvoice_projects")
      .update({
        status: "parsed",
        total_lines: result.total_lines,
        script_imported_at: new Date().toISOString(),
      })
      .eq("id", project.id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ parsed: result });
  } catch (err) {
    let message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof VoiceEngineError && err.details) {
      const d = err.details as { detail?: unknown };
      const detail =
        d && typeof d === "object" && "detail" in d ? d.detail : err.details;
      if (detail) {
        message += ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }
    await notifyError(req.org!.id, "smrtvoice", {
      title: "Failed to parse script",
      body: message,
    });
    res.status(502).json({ error: message });
  }
});

router.post("/voice/projects/:id/upload-url", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const fileName: string = (req.body?.fileName as string) || "recording.wav";

  const { data: project, error: projectErr } = await db
    .from("smrtvoice_projects")
    .select("id")
    .eq("id", projectId)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (projectErr) return res.status(500).json({ error: projectErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const path = `${req.org!.id}/projects/${projectId}/input/${fileName}`;

  const { data, error } = await db.storage
    .from("smrtvoice-audio")
    .createSignedUploadUrl(path);

  if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
  res.json({ upload_url: data.signedUrl, path: data.path, token: data.token });
});

router.post("/voice/projects/:id/generate", async (req: Request, res: Response) => {
  const { data: project, error: projectErr } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (projectErr) return res.status(500).json({ error: projectErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.status === "queued" || project.status === "processing") {
    return res.status(409).json({ error: "Project is already being processed" });
  }

  // Budget check
  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("*")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (settings) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { data: monthCosts } = await db
      .from("smrtvoice_projects")
      .select("total_cost_usd")
      .eq("org_id", req.org!.id)
      .gte("created_at", monthStart.toISOString());

    const totalThisMonth = (monthCosts ?? []).reduce(
      (sum: number, p: { total_cost_usd: number | null }) => sum + (p.total_cost_usd ?? 0),
      0,
    );

    if (totalThisMonth >= settings.monthly_budget_usd * settings.budget_block_threshold) {
      return res.status(402).json({
        error: "monthly_budget_exceeded",
        current: totalThisMonth,
        budget: settings.monthly_budget_usd,
      });
    }
  }

  try {
    let inputAudioUrl: string | undefined;
    if (project.generation_mode === "sts" && project.input_recording_path) {
      const { data: urlData } = await db.storage
        .from("smrtvoice-audio")
        .createSignedUrl(project.input_recording_path, 3600);
      inputAudioUrl = urlData?.signedUrl;
    }

    // voice-engine needs the user's Google access token to fetch the doc when
    // running the orchestrator. We pass it along on every job that has a doc.
    let googleAccessToken: string | undefined;
    if (project.google_doc_id) {
      try {
        const oauthClient = await getOAuthClient(req.user!.id, "drive");
        googleAccessToken = oauthClient.credentials.access_token ?? undefined;
      } catch {
        return res.status(400).json({
          error: "Google Drive is not connected. Connect via Settings → Connections before generating.",
        });
      }
    }

    const client = getVoiceEngineClient();
    const engineJob = await client.createJob({
      org_id: req.org!.id,
      project_id: project.id,
      user_id: req.user!.id,
      job_type: "generate_audio",
      adapter: settings?.default_adapter ?? "resemble",
      mode: project.generation_mode,
      google_doc_id: project.google_doc_id ?? undefined,
      google_oauth_token: googleAccessToken,
      google_doc_tab_id: project.google_doc_tab_id ?? undefined,
      google_doc_tab_title: project.google_doc_tab_title ?? undefined,
      input_audio_url: inputAudioUrl,
      llm_model: settings?.default_llm_model ?? undefined,
      code: project.code ?? undefined,
      postprocess_enabled: settings?.postprocess_enabled ?? undefined,
      postprocess_compress: settings?.postprocess_compress ?? undefined,
      postprocess_speed: settings?.postprocess_speed ?? undefined,
    });

    const { data: job, error: jobErr } = await db
      .from("smrtvoice_jobs")
      .insert({
        org_id: req.org!.id,
        project_id: project.id,
        created_by: req.user!.id,
        job_type: "generate_audio",
        adapter: settings?.default_adapter ?? "resemble",
        voice_engine_job_id: engineJob.job_id,
        status: "queued",
      })
      .select()
      .single();

    if (jobErr || !job) {
      return res.status(500).json({ error: jobErr?.message ?? "job insert failed" });
    }

    const { error: projectUpdateErr } = await db
      .from("smrtvoice_projects")
      .update({ status: "queued" })
      .eq("id", project.id);

    if (projectUpdateErr) {
      // Surface this but don't fail the request — the job is already queued upstream.
      await notifyError(req.org!.id, "smrtvoice", {
        title: "Failed to update project status after queueing job",
        body: projectUpdateErr.message,
      });
    }

    await emitEvent(
      req.org!.id,
      "smrtvoice",
      "job.queued",
      "job",
      job.id,
      { project_id: project.id, estimated_seconds: engineJob.estimated_seconds },
    );

    res.json({ job, estimated_seconds: engineJob.estimated_seconds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await notifyError(req.org!.id, "smrtvoice", {
      title: "Failed to start audio generation",
      body: message,
    });
    res.status(502).json({ error: message });
  }
});

router.post("/voice/projects/:id/mark-complete", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_projects")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });

  await emitEvent(
    req.org!.id,
    "smrtvoice",
    "project.completed",
    "project",
    data.id,
    { name: data.name },
  );

  res.json({ project: data });
});

// POST /voice/projects/:id/archive — save all completed line audio to Drive.
// Creates a sub-folder named by the program code under the target folder
// (per-project override → org archive folder), uploads every completed WAV,
// then records the folder + marks the project archived.
router.post("/voice/projects/:id/archive", async (req: Request, res: Response) => {
  const { data: project, error: projErr } = await db
    .from("smrtvoice_projects")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (projErr) return res.status(500).json({ error: projErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select("gdrive_archive_folder_id")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  // Per-project override wins; otherwise the org-wide archive root.
  const rootFolderId = project.gdrive_target_folder_id || settings?.gdrive_archive_folder_id;
  if (!rootFolderId) {
    return res.status(400).json({
      error:
        "No Drive folder configured. Set an archive folder in Voice settings, " +
        "or a target folder on this project.",
    });
  }

  const { data: lines, error: linesErr } = await db
    .from("smrtvoice_lines")
    .select("line_number, speaker_name, output_audio_path")
    .eq("project_id", project.id)
    .eq("org_id", req.org!.id)
    .eq("status", "completed")
    .not("output_audio_path", "is", null)
    .order("line_number");
  if (linesErr) return res.status(500).json({ error: linesErr.message });
  if (!lines || lines.length === 0) {
    return res.status(400).json({ error: "No completed audio to archive yet" });
  }

  try {
    const drive = await getDriveClient(req.user!.id);

    // Reuse an existing sub-folder for this project, else create one.
    let folderId = project.archive_gdrive_folder_id as string | null;
    let folderUrl = project.archive_gdrive_folder_url as string | null;
    if (!folderId) {
      const folderName = project.code || project.name;
      const folder = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [rootFolderId],
        },
        fields: "id, webViewLink",
        supportsAllDrives: true,
      });
      folderId = folder.data.id ?? null;
      folderUrl = folder.data.webViewLink ?? null;
    }
    if (!folderId) {
      return res.status(502).json({ error: "Failed to create Drive folder" });
    }

    const { error: archivingErr } = await db
      .from("smrtvoice_projects")
      .update({ status: "archiving" })
      .eq("id", project.id);
    if (archivingErr) {
      console.warn("[smrtvoice] failed to set archiving status:", archivingErr.message);
    }

    let uploaded = 0;
    let skipped = 0;
    for (const line of lines as Array<{
      line_number: number;
      speaker_name: string;
      output_audio_path: string;
    }>) {
      const { data: blob, error: dlErr } = await db.storage
        .from("smrtvoice-audio")
        .download(line.output_audio_path);
      if (dlErr || !blob) {
        skipped += 1;
        continue;
      }

      const buffer = Buffer.from(await blob.arrayBuffer());
      const baseName = project.code
        ? `${project.code}_${String(line.line_number).padStart(3, "0")}.wav`
        : (line.output_audio_path.split("/").pop() ?? `line_${line.line_number}.wav`);

      await drive.files.create({
        requestBody: { name: baseName, parents: [folderId] },
        media: { mimeType: "audio/wav", body: Readable.from(buffer) },
        fields: "id",
        supportsAllDrives: true,
      });
      uploaded += 1;
    }

    // Nothing uploaded → don't claim success; revert so the user can retry.
    if (uploaded === 0) {
      await db
        .from("smrtvoice_projects")
        .update({ status: "audio_ready" })
        .eq("id", project.id);
      return res
        .status(502)
        .json({ error: "Failed to upload any audio to Drive", skipped });
    }

    // Only mark fully archived when every file made it; on a partial upload
    // leave the project in audio_ready so the remaining files can be re-archived.
    const fullyArchived = skipped === 0;
    const { data: updated, error: updErr } = await db
      .from("smrtvoice_projects")
      .update({
        status: fullyArchived ? "archived" : "audio_ready",
        archive_gdrive_folder_id: folderId,
        archive_gdrive_folder_url: folderUrl,
        archived_at: fullyArchived ? new Date().toISOString() : null,
      })
      .eq("id", project.id)
      .select()
      .maybeSingle();
    if (updErr) return res.status(500).json({ error: updErr.message });

    await emitEvent(req.org!.id, "smrtvoice", "project.archived", "project", project.id, {
      folder_url: folderUrl,
      uploaded,
      skipped,
    });

    res.json({ project: updated, folder_url: folderUrl, uploaded, skipped });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await notifyError(req.org!.id, "smrtvoice", {
      title: "Failed to archive project to Drive",
      body: message,
    });
    res.status(502).json({ error: message });
  }
});

// ============================================================
// LINES
// ============================================================

router.get("/voice/projects/:id/lines", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtvoice_lines")
    .select("*")
    .eq("project_id", req.params.id)
    .eq("org_id", req.org!.id)
    .order("line_number");

  if (error) return res.status(500).json({ error: error.message });
  res.json({ lines: data ?? [] });
});

const LINE_UPDATABLE = new Set([
  "text_clean",
  "text_for_tts",
  "tts_body",
  "tags",
  "emotion",
  "emotion_source",
  "character_id",
  "emotion_profile_id",
  "final_exaggeration",
  "final_pitch",
  "final_pace",
  "status",
]);

router.patch("/voice/lines/:id", async (req: Request, res: Response) => {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (LINE_UPDATABLE.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields in body" });
  }

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

// Re-render a set of line numbers in a project via voice-engine. Inserts a
// tracking job row and returns it. Shared by single-line regenerate and the
// batch "re-run everything marked for redo" action.
async function queueRegeneration(
  req: Request,
  res: Response,
  project: { id: string; code: string | null },
  lineNumbers: number[],
) {
  if (lineNumbers.length === 0) {
    return res.status(400).json({ error: "No lines to regenerate" });
  }

  const { data: settings } = await db
    .from("smrtvoice_settings")
    .select(
      "default_adapter, default_llm_model, postprocess_enabled, postprocess_compress, postprocess_speed",
    )
    .eq("org_id", req.org!.id)
    .maybeSingle();

  try {
    const client = getVoiceEngineClient();
    const engineJob = await client.createJob({
      org_id: req.org!.id,
      project_id: project.id,
      user_id: req.user!.id,
      job_type: "regenerate_line",
      adapter: settings?.default_adapter ?? "resemble",
      mode: "tts",
      llm_model: settings?.default_llm_model ?? undefined,
      code: project.code ?? undefined,
      line_numbers: lineNumbers,
      postprocess_enabled: settings?.postprocess_enabled ?? undefined,
      postprocess_compress: settings?.postprocess_compress ?? undefined,
      postprocess_speed: settings?.postprocess_speed ?? undefined,
    });

    const { data: job, error: jobErr } = await db
      .from("smrtvoice_jobs")
      .insert({
        org_id: req.org!.id,
        project_id: project.id,
        created_by: req.user!.id,
        job_type: "regenerate_line",
        adapter: settings?.default_adapter ?? "resemble",
        voice_engine_job_id: engineJob.job_id,
        status: "queued",
      })
      .select()
      .single();

    if (jobErr || !job) {
      return res.status(500).json({ error: jobErr?.message ?? "job insert failed" });
    }

    // Flip the queued lines to processing and clear their redo flag now, so a
    // second "re-run redos" click doesn't re-queue the same lines while they're
    // mid-render. redone_at marks them as freshly re-rendered (for "play new").
    const { error: flipErr } = await db
      .from("smrtvoice_lines")
      .update({
        status: "processing",
        redo_requested: false,
        redone_at: new Date().toISOString(),
      })
      .eq("project_id", project.id)
      .eq("org_id", req.org!.id)
      .in("line_number", lineNumbers);
    if (flipErr) {
      console.warn("[smrtvoice] failed to flip redo lines to processing:", flipErr.message);
    }

    res.json({ job, line_numbers: lineNumbers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
}

router.post("/voice/lines/:id/regenerate", async (req: Request, res: Response) => {
  const { data: line, error: lineErr } = await db
    .from("smrtvoice_lines")
    .select("project_id, line_number")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const { data: project } = await db
    .from("smrtvoice_projects")
    .select("id, code")
    .eq("id", line.project_id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (!project) return res.status(404).json({ error: "Project not found" });

  await queueRegeneration(req, res, project, [line.line_number]);
});

// Mark a line as needing a re-record, with the reason / required fix.
router.post("/voice/lines/:id/redo", async (req: Request, res: Response) => {
  const reason: string = (req.body?.reason ?? "").toString().trim();
  const instructions: string = (req.body?.instructions ?? "").toString().trim();

  const { data, error } = await db
    .from("smrtvoice_lines")
    .update({
      redo_requested: true,
      redo_reason: reason || null,
      redo_instructions: instructions || null,
    })
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ line: data });
});

// Clear a redo flag without regenerating.
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

// Re-run every line marked for redo in a project.
router.post("/voice/projects/:id/regenerate-redos", async (req: Request, res: Response) => {
  const { data: project, error: projErr } = await db
    .from("smrtvoice_projects")
    .select("id, code")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (projErr) return res.status(500).json({ error: projErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { data: lines, error: linesErr } = await db
    .from("smrtvoice_lines")
    .select("line_number")
    .eq("project_id", project.id)
    .eq("org_id", req.org!.id)
    .eq("redo_requested", true)
    .order("line_number");
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  const lineNumbers = (lines ?? []).map((l: { line_number: number }) => l.line_number);
  if (lineNumbers.length === 0) {
    return res.status(400).json({ error: "No lines are marked for redo" });
  }
  await queueRegeneration(req, res, project, lineNumbers);
});

router.get("/voice/lines/:id/audio-url", async (req: Request, res: Response) => {
  const { data: line, error: lineErr } = await db
    .from("smrtvoice_lines")
    .select("output_audio_path, org_id")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line || !line.output_audio_path) return res.status(404).json({ error: "Audio not found" });

  const { data, error } = await db.storage
    .from("smrtvoice-audio")
    .createSignedUrl(line.output_audio_path, 3600);

  if (error || !data) return res.status(500).json({ error: error?.message ?? "signing failed" });
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

// Whitelisted settings columns — blocks a client from rewriting id/org_id/
// timestamps via free-form PATCH body.
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
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updatable fields in body" });
    }

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

router.post("/voice/lexicon", async (req: Request, res: Response) => {
  const { original_word, pronounced_as, category, notes } = req.body ?? {};
  if (!original_word || !pronounced_as) {
    return res.status(400).json({ error: "original_word and pronounced_as required" });
  }

  const { data, error } = await db
    .from("smrtvoice_pronunciation_lexicon")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      original_word,
      pronounced_as,
      category: category ?? "general",
      notes: notes ?? null,
    })
    .select()
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message ?? "create failed" });
  res.status(201).json({ entry: data });
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

export default router;
