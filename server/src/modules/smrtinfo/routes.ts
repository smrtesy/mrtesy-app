/**
 * smrtInfo — Express routes (authenticated).
 *
 * Every route requires: requireAuth → requireOrg → requireApp("smrtinfo").
 *
 * The information center: a searchable knowledge base of facts extracted from
 * the ingest stream, answerable in free text. All queries use the service-role
 * db client and are scoped by org_id (and user_id for personal facts). Passwords
 * live only in smrtVault; this module surfaces save-suggestions, never plaintext.
 */

import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { simpleCall, parseJsonResponse } from "../../anthropic";
import { embedText } from "../../services/voyage";
import { extractAndStore } from "./extract";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrtinfo"));

const FACT_COLUMNS =
  "id, scope, entity, attribute, value, effective_date, confidence, verified, source_type, source_url, source_message_id, created_at, updated_at";

const MAX_FIELD = 4096;

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_FIELD) : null;
}

/** Which scopes the caller may read (personal only their own — enforced in SQL). */
function requestedScopes(raw: unknown): string[] {
  const valid = ["personal", "org", "unclassified"];
  if (typeof raw === "string" && valid.includes(raw)) return [raw];
  return valid;
}

/** Rough tokenizer for keyword fallback / vault matching. */
function tokenize(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s'".@-]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3),
    ),
  ).slice(0, 6);
}

function renderFact(entity: string, attribute: string, value: string): string {
  return `${entity} — ${attribute}: ${value}`;
}

// ============================================================
// FACTS — list / create / update / delete
// ============================================================

/** GET /info/facts?scope=&verified=&q= — current (non-superseded) facts. */
router.get("/info/facts", async (req: Request, res: Response) => {
  const scope = typeof req.query.scope === "string" ? req.query.scope : null;
  // Strip PostgREST filter separators before interpolating into .or() below.
  const q = (typeof req.query.q === "string" ? req.query.q.trim() : "").replace(/[,()*\\]/g, " ").trim();

  let query = db
    .from("info_facts")
    .select(FACT_COLUMNS)
    .eq("org_id", req.org!.id)
    .is("superseded_by", null)
    // personal facts are private to their owner; org/unclassified are org-wide
    .or(`scope.neq.personal,user_id.eq.${req.user!.id}`)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (scope && ["personal", "org", "unclassified"].includes(scope)) {
    query = query.eq("scope", scope);
  }
  if (typeof req.query.verified === "string") {
    query = query.eq("verified", req.query.verified === "true");
  }
  if (q) {
    query = query.or(`entity.ilike.%${q}%,attribute.ilike.%${q}%,value.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ facts: data ?? [] });
});

/** POST /info/facts — manually add a fact (user-entered → verified). */
router.post("/info/facts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entity = clean(body.entity);
  const attribute = clean(body.attribute);
  const value = clean(body.value);
  if (!entity || !attribute || !value) {
    return res.status(400).json({ error: "entity, attribute and value are required" });
  }
  const scope = ["personal", "org", "unclassified"].includes(String(body.scope))
    ? String(body.scope)
    : "unclassified";
  const effectiveDate =
    typeof body.effective_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date)
      ? body.effective_date
      : null;

  const embedding = await embedText(renderFact(entity, attribute, value), "document", {
    userId: req.user!.id,
  });

  const { data, error } = await db
    .from("info_facts")
    .insert({
      org_id: req.org!.id,
      user_id: req.user!.id,
      scope,
      entity,
      attribute,
      value,
      effective_date: effectiveDate,
      confidence: 1,
      verified: true,
      source_url: clean(body.source_url),
      embedding: embedding ? JSON.stringify(embedding) : null,
    })
    .select(FACT_COLUMNS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ fact: data });
});

/** PATCH /info/facts/:id — edit fields; re-embed if the text changed. */
router.patch("/info/facts/:id", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const { data: row, error: fetchErr } = await db
    .from("info_facts")
    .select("id, entity, attribute, value")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .or(`scope.neq.personal,user_id.eq.${req.user!.id}`)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "fact not found" });

  const cur = row as { id: string; entity: string; attribute: string; value: string };
  const patch: Record<string, unknown> = {};
  if ("entity" in body) patch.entity = clean(body.entity) ?? cur.entity;
  if ("attribute" in body) patch.attribute = clean(body.attribute) ?? cur.attribute;
  if ("value" in body) patch.value = clean(body.value) ?? cur.value;
  if ("scope" in body && ["personal", "org", "unclassified"].includes(String(body.scope))) {
    patch.scope = String(body.scope);
  }
  if ("verified" in body) patch.verified = Boolean(body.verified);
  if ("effective_date" in body) {
    patch.effective_date =
      typeof body.effective_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date)
        ? body.effective_date
        : null;
  }
  if (Object.keys(patch).length === 0) return res.json({ ok: true });

  // Re-embed when any text field changed.
  const newEntity = (patch.entity as string) ?? cur.entity;
  const newAttribute = (patch.attribute as string) ?? cur.attribute;
  const newValue = (patch.value as string) ?? cur.value;
  if ("entity" in patch || "attribute" in patch || "value" in patch) {
    const embedding = await embedText(
      renderFact(newEntity, newAttribute, newValue),
      "document",
      { userId: req.user!.id },
    );
    if (embedding) patch.embedding = JSON.stringify(embedding);
  }

  const { data, error } = await db
    .from("info_facts")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .or(`scope.neq.personal,user_id.eq.${req.user!.id}`)
    .select(FACT_COLUMNS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ fact: data });
});

/** DELETE /info/facts/:id */
router.delete("/info/facts/:id", async (req: Request, res: Response) => {
  const { error } = await db
    .from("info_facts")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .or(`scope.neq.personal,user_id.eq.${req.user!.id}`);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// ASK — natural-language question over the knowledge base
// ============================================================

interface FactMatch {
  id: string;
  scope: string;
  entity: string;
  attribute: string;
  value: string;
  effective_date: string | null;
  confidence: number | null;
  verified: boolean;
  source_type: string | null;
  source_url: string | null;
  similarity?: number;
}

function buildAskSystem(): string {
  return `You are the answer engine for a personal/organizational information center.
You receive a QUESTION and a numbered list of FACTS (each: subject/entity,
attribute, value, scope, source). Answer STRICTLY from these facts.

CRITICAL — subject match:
- A fact's SUBJECT (its entity — the person/company/thing it is about) must
  actually match the SUBJECT of the question. A fact about one person or entity
  does NOT answer a question about a different one. Example: a fact about
  "דובי חסקינד" does NOT answer "the medical insurance of my children".
- Use ONLY facts that DIRECTLY answer the question. IGNORE facts that merely
  share a word (e.g. "ילדים"/"kids" appearing inside an unrelated project name
  like "רבי לילדים").

If NO fact directly answers the question:
- Say so honestly, in the question's language (e.g. "לא נמצא מידע על ...").
- You MAY briefly mention a related-but-not-matching fact AS related only
  (e.g. "קיימת רשומה על ביטוח של דובי חסקינד, אך לא על הילדים") — never present
  it as the answer.

Other rules:
- Passwords: if a VAULT MATCH genuinely matches, say the credential is in
  smrtVault (use "reveal" there); NEVER state a password.
- Preserve any source URL VERBATIM (full URL, never a bare domain).
- Answer in the SAME LANGUAGE as the question (Hebrew stays Hebrew), concise.

Return ONLY this JSON (no markdown, no prose outside it):
{
  "answer": "the concise answer, or an honest not-found, in the question's language",
  "used_facts": [the #numbers of the facts you actually used to answer; [] if none]
}`;
}

/** POST /info/ask { question, scope? } */
router.post("/info/ask", async (req: Request, res: Response) => {
  const question = clean((req.body ?? {}).question);
  if (!question) return res.status(400).json({ error: "question is required" });
  const scopes = requestedScopes((req.body ?? {}).scope);

  // 1. Retrieve candidate facts — vector search, keyword fallback.
  let facts: FactMatch[] = [];
  const embedding = await embedText(question, "query", { userId: req.user!.id });
  if (embedding) {
    const { data, error } = await db.rpc("match_info_facts", {
      query_embedding: JSON.stringify(embedding),
      p_org_id: req.org!.id,
      p_user_id: req.user!.id,
      p_scopes: scopes,
      // Tighter than the old 0.5 (cosine distance): 0.5 let weakly-related facts
      // through (e.g. a "רבי לילדים" project item matching "הילדים שלי"). Voyage
      // does recall; Claude does the final subject-match judgment below.
      match_threshold: 0.35,
      match_count: 10,
    });
    if (error) return res.status(500).json({ error: error.message });
    facts = (data as FactMatch[]) ?? [];
  }
  if (facts.length === 0) {
    // keyword fallback (also used when Voyage is unconfigured)
    const tokens = tokenize(question);
    if (tokens.length) {
      const orExpr = tokens
        .map((t) => `entity.ilike.%${t}%,attribute.ilike.%${t}%,value.ilike.%${t}%`)
        .join(",");
      const { data, error } = await db
        .from("info_facts")
        .select(FACT_COLUMNS)
        .eq("org_id", req.org!.id)
        .is("superseded_by", null)
        .or(`scope.neq.personal,user_id.eq.${req.user!.id}`)
        .or(orExpr)
        .limit(10);
      if (error) console.error("[smrtinfo] ask keyword fallback:", error.message);
      facts = (data as FactMatch[]) ?? [];
    }
  }

  // 2. Vault matches (metadata only — never the password).
  const tokens = tokenize(question);
  let vaultMatches: { id: string; label: string; username: string | null; url: string | null }[] = [];
  if (tokens.length) {
    const orExpr = tokens.map((t) => `label.ilike.%${t}%,username.ilike.%${t}%,url.ilike.%${t}%`).join(",");
    const { data, error } = await db
      .from("smrtvault_credentials")
      .select("id, label, username, url")
      .eq("org_id", req.org!.id)
      .eq("user_id", req.user!.id)
      .or(orExpr)
      .limit(5);
    if (error) console.error("[smrtinfo] ask vault match:", error.message);
    vaultMatches = (data as typeof vaultMatches) ?? [];
  }

  // 3. Compose the answer with Sonnet.
  if (facts.length === 0 && vaultMatches.length === 0) {
    return res.json({ answer: null, facts: [], vaultMatches: [] });
  }

  const factLines = facts
    .map(
      (f, i) =>
        `#${i + 1} [${f.scope}] ${f.entity} — ${f.attribute}: ${f.value}` +
        (f.effective_date ? ` (date: ${f.effective_date})` : "") +
        (f.source_url ? `\n   source: ${f.source_url}` : ""),
    )
    .join("\n");
  const vaultLines = vaultMatches
    .map((v) => `- ${v.label}${v.username ? ` (user: ${v.username})` : ""}`)
    .join("\n");

  const userMessage = `QUESTION:\n${question}\n\nFACTS:\n${factLines || "(none)"}\n\nVAULT MATCHES (passwords in smrtVault — do not state them):\n${vaultLines || "(none)"}`;

  const { content: raw } = await simpleCall("sonnet", buildAskSystem(), userMessage, 1024, {
    component: "server.smrtinfo.ask",
    userId: req.user!.id,
  });

  // The model returns { answer, used_facts:[#..] }. Surface ONLY the facts it
  // actually used as sources — not every loosely-retrieved candidate (that was
  // the "unrelated sources" bug). If it didn't return a usable list, show no
  // sources rather than a wall of irrelevant ones.
  const parsed = parseJsonResponse<{ answer?: string; used_facts?: number[] }>(raw);
  const answer = (parsed?.answer ?? raw ?? "").trim();
  const usedSet = new Set(
    (Array.isArray(parsed?.used_facts) ? parsed!.used_facts! : []).map((n) => Number(n)),
  );
  const sources =
    parsed && Array.isArray(parsed.used_facts)
      ? facts.filter((_, i) => usedSet.has(i + 1))
      : [];

  res.json({ answer, facts: sources, vaultMatches });
});

// ============================================================
// CONTEXT PROFILE — personal/org disambiguation key
// ============================================================

router.get("/info/context-profile", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("info_context_profile")
    .select("profile")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: (data as { profile?: unknown } | null)?.profile ?? {} });
});

router.put("/info/context-profile", async (req: Request, res: Response) => {
  const profile = (req.body ?? {}).profile;
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    return res.status(400).json({ error: "profile must be an object" });
  }
  const { data, error } = await db
    .from("info_context_profile")
    .upsert(
      { org_id: req.org!.id, user_id: req.user!.id, profile },
      { onConflict: "org_id,user_id" },
    )
    .select("profile")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: (data as { profile?: unknown }).profile });
});

// ============================================================
// EXTRACT — build the knowledge base from ingested messages
// (used by the initial data-population run and the classifier hook)
// ============================================================

/**
 * POST /info/extract
 * Body: either { source_message_id } to extract from a stored message, or a raw
 * { content, subject?, sender?, source_type?, source_url? }.
 */
router.post("/info/extract", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const orgId = req.org!.id;
  const userId = req.user!.id;

  if (typeof body.source_message_id === "string" && body.source_message_id) {
    const { data: msg, error } = await db
      .from("source_messages")
      .select("id, raw_content, body_text, subject, sender, source_type, source_url")
      .eq("user_id", userId)
      .eq("id", body.source_message_id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!msg) return res.status(404).json({ error: "source message not found" });
    const m = msg as {
      id: string;
      raw_content: string | null;
      body_text: string | null;
      subject: string | null;
      sender: string | null;
      source_type: string | null;
      source_url: string | null;
    };
    const result = await extractAndStore(orgId, userId, {
      sourceMessageId: m.id,
      sourceType: m.source_type,
      sourceUrl: m.source_url,
      subject: m.subject,
      sender: m.sender,
      content: m.raw_content || m.body_text || "",
    });
    return res.json(result);
  }

  const content = clean(body.content);
  if (!content) return res.status(400).json({ error: "content or source_message_id is required" });
  const result = await extractAndStore(orgId, userId, {
    content,
    subject: clean(body.subject),
    sender: clean(body.sender),
    sourceType: clean(body.source_type),
    sourceUrl: clean(body.source_url),
  });
  res.json(result);
});

// ============================================================
// SECRET SUGGESTIONS — approve → smrtVault, or dismiss
// ============================================================

router.get("/info/secret-suggestions", async (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const { data, error } = await db
    .from("info_secret_suggestions")
    .select("id, label, username, url, source_type, source_url, status, credential_id, created_at")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("status", status)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ suggestions: data ?? [] });
});

/** Approve → create an smrtvault_credentials row reusing the pending secret. */
router.post("/info/secret-suggestions/:id/approve", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { data: row, error: fetchErr } = await db
    .from("info_secret_suggestions")
    .select("id, label, username, url, password_secret_id, status")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "suggestion not found" });
  const s = row as {
    id: string;
    label: string;
    username: string | null;
    url: string | null;
    password_secret_id: string;
    status: string;
  };
  if (s.status !== "pending") return res.status(409).json({ error: "already resolved" });

  const { data: cred, error: credErr } = await db
    .from("smrtvault_credentials")
    .insert({
      org_id: req.org!.id,
      user_id: req.user!.id,
      label: clean(body.label) ?? s.label,
      username: clean(body.username) ?? s.username,
      url: clean(body.url) ?? s.url,
      password_secret_id: s.password_secret_id,
    })
    .select("id")
    .single();
  if (credErr) return res.status(500).json({ error: credErr.message });

  const { error: updErr } = await db
    .from("info_secret_suggestions")
    .update({ status: "approved", credential_id: (cred as { id: string }).id })
    .eq("id", s.id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  res.json({ ok: true, credential_id: (cred as { id: string }).id });
});

/** Dismiss → neutralize the pending Vault secret (overwrite empty). */
router.post("/info/secret-suggestions/:id/dismiss", async (req: Request, res: Response) => {
  const { data: row, error: fetchErr } = await db
    .from("info_secret_suggestions")
    .select("id, password_secret_id, status")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.user!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: "suggestion not found" });
  const s = row as { id: string; password_secret_id: string; status: string };
  if (s.status !== "pending") return res.status(409).json({ error: "already resolved" });

  // Best-effort neutralize; proceed to mark dismissed regardless.
  const { error: vErr } = await db.rpc("vault_update_secret", {
    secret_id: s.password_secret_id,
    new_secret: "",
  });
  if (vErr) console.error("[smrtinfo] neutralize secret:", vErr.message);

  const { error } = await db
    .from("info_secret_suggestions")
    .update({ status: "dismissed" })
    .eq("id", s.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
