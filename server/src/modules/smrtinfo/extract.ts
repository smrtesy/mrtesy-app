/**
 * smrtInfo — fact extraction.
 *
 * Reads ONE message, asks Sonnet for durable facts, embeds each fact with
 * Voyage, and upserts into info_facts with supersede-on-change. Detected
 * passwords are NEVER stored as facts: the candidate secret is written to
 * Supabase Vault as a PENDING secret and surfaced as an info_secret_suggestions
 * row for the user to approve (→ smrtVault) or dismiss.
 *
 * All writes use the service-role db client, so every query is scoped by
 * org_id / user_id explicitly.
 */

import { randomUUID } from "crypto";

import { db } from "../../db";
import { simpleCall, parseJsonResponse } from "../../anthropic";
import { embedText } from "../../services/voyage";
import { getUserPromptContext } from "../../lib/user-context";
import {
  buildInfoExtractSystem,
  type InfoContextProfile,
} from "../../prompts/info-extract";

// A fact whose confidence is at/above this lands verified=true (live &
// authoritative). Below it, the fact is stored verified=false ("not verified")
// and offered for one-tap approval. This is the hybrid extraction gate.
const VERIFY_CONFIDENCE = 0.85;
// Facts weaker than this are dropped entirely (too speculative to keep).
const MIN_CONFIDENCE = 0.5;

export interface ExtractedFact {
  entity?: string;
  attribute?: string;
  value?: string;
  effective_date?: string | null;
  confidence?: number;
  scope?: string;
  is_secret?: boolean;
  secret_label?: string | null;
  secret_value?: string | null;
  language?: string | null;
}

export interface ExtractSource {
  /** source_messages row id, if extracting from a stored message. */
  sourceMessageId?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  subject?: string | null;
  sender?: string | null;
  /** The message body / document text / transcript to extract from. */
  content: string;
}

export interface ExtractResult {
  factsStored: number;
  factsSuperseded: number;
  secretSuggestions: number;
  dropped: number;
  costUsd: number;
}

const SCOPES = new Set(["personal", "org", "unclassified"]);

/** Natural-language rendering of a fact — this is what we embed & search over. */
function renderFact(f: { entity: string; attribute: string; value: string }): string {
  return `${f.entity} — ${f.attribute}: ${f.value}`;
}

/** Load the caller's editable context profile (personal/org disambiguation). */
async function loadContextProfile(
  orgId: string,
  userId: string,
): Promise<InfoContextProfile | null> {
  const { data } = await db
    .from("info_context_profile")
    .select("profile")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  const profile = (data as { profile?: InfoContextProfile } | null)?.profile;
  return profile && Object.keys(profile).length > 0 ? profile : null;
}

/** Create a PENDING Vault secret and return its id (or null on failure). */
async function createPendingVaultSecret(
  value: string,
  label: string,
): Promise<string | null> {
  const { data, error } = await db.rpc("vault_create_secret", {
    new_secret: value,
    new_name: `smrtvault:${randomUUID()}`,
    new_description: `smrtInfo pending credential: ${label}`.slice(0, 500),
  });
  if (error) {
    console.error("[smrtinfo] vault_create_secret failed:", error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Extract facts from a single message and store them.
 * Returns counts; never throws on individual-fact failures (best-effort).
 */
export async function extractAndStore(
  orgId: string,
  userId: string,
  src: ExtractSource,
): Promise<ExtractResult> {
  const result: ExtractResult = {
    factsStored: 0,
    factsSuperseded: 0,
    secretSuggestions: 0,
    dropped: 0,
    costUsd: 0,
  };

  const content = (src.content ?? "").trim();
  if (!content) return result;

  const [ctx, profile] = await Promise.all([
    getUserPromptContext(userId, orgId),
    loadContextProfile(orgId, userId),
  ]);

  const system = buildInfoExtractSystem(ctx, profile);
  const userMessage = [
    src.sender ? `From: ${src.sender}` : null,
    src.sourceType ? `Channel: ${src.sourceType}` : null,
    src.subject ? `Subject: ${src.subject}` : null,
    "",
    content,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const { content: raw, costUsd } = await simpleCall(
    "sonnet",
    system,
    userMessage,
    2048,
    { component: "server.smrtinfo.extract", userId, refId: src.sourceMessageId ?? undefined },
  );
  result.costUsd = costUsd;

  const parsed = parseJsonResponse<{ facts?: ExtractedFact[] }>(raw);
  const facts = Array.isArray(parsed?.facts) ? parsed!.facts! : [];

  for (const f of facts) {
    // ── Secret → pending Vault suggestion (never a fact) ──────────
    if (f.is_secret) {
      const secret = typeof f.secret_value === "string" ? f.secret_value : "";
      const label = (f.secret_label || f.entity || "").trim();
      if (!secret || !label) {
        result.dropped++;
        continue;
      }
      const secretId = await createPendingVaultSecret(secret, label);
      if (!secretId) {
        result.dropped++;
        continue;
      }
      const { error } = await db.from("info_secret_suggestions").insert({
        org_id: orgId,
        user_id: userId,
        label,
        url: src.sourceUrl ?? null,
        password_secret_id: secretId,
        source_message_id: src.sourceMessageId ?? null,
        source_type: src.sourceType ?? null,
        source_url: src.sourceUrl ?? null,
      });
      if (error) {
        console.error("[smrtinfo] secret suggestion insert:", error.message);
        result.dropped++;
        continue;
      }
      result.secretSuggestions++;
      continue;
    }

    // ── Normal fact ──────────────────────────────────────────────
    const entity = (f.entity ?? "").trim();
    const attribute = (f.attribute ?? "").trim();
    const value = (f.value ?? "").trim();
    const confidence = typeof f.confidence === "number" ? f.confidence : 0;
    if (!entity || !attribute || !value || confidence < MIN_CONFIDENCE) {
      result.dropped++;
      continue;
    }

    const scope = SCOPES.has(f.scope ?? "") ? (f.scope as string) : "unclassified";
    const effectiveDate = f.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(f.effective_date)
      ? f.effective_date
      : null;

    const embedding = await embedText(renderFact({ entity, attribute, value }), "document", {
      userId,
      refId: src.sourceMessageId ?? undefined,
    });

    // Supersede an existing current fact with the same key whose value changed.
    // Exact match (not ilike — attributes like "payment_date" contain "_",
    // which ilike would treat as a wildcard). limit(1) + take first avoids a
    // maybeSingle() error when more than one current row shares the key.
    let query = db
      .from("info_facts")
      .select("id, value")
      .eq("org_id", orgId)
      .eq("scope", scope)
      .eq("entity", entity)
      .eq("attribute", attribute)
      .is("superseded_by", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (scope === "personal") query = query.eq("user_id", userId);
    const { data: existingRows, error: existingErr } = await query;
    if (existingErr) console.error("[smrtinfo] supersede lookup:", existingErr.message);
    const existingRow =
      (existingRows?.[0] as { id: string; value: string } | undefined) ?? null;
    if (existingRow && existingRow.value.trim() === value) {
      // identical fact already current — nothing to do
      continue;
    }

    const { data: inserted, error: insErr } = await db
      .from("info_facts")
      .insert({
        org_id: orgId,
        user_id: userId,
        scope,
        entity,
        attribute,
        value,
        effective_date: effectiveDate,
        confidence,
        verified: confidence >= VERIFY_CONFIDENCE,
        language: f.language ?? null,
        source_message_id: src.sourceMessageId ?? null,
        source_type: src.sourceType ?? null,
        source_url: src.sourceUrl ?? null,
        embedding: embedding ? JSON.stringify(embedding) : null,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[smrtinfo] fact insert:", insErr?.message);
      result.dropped++;
      continue;
    }
    result.factsStored++;

    if (existingRow) {
      // archive the old value and point it at the replacement
      const { error: histErr } = await db.from("info_fact_history").insert({
        fact_id: existingRow.id,
        org_id: orgId,
        user_id: userId,
        scope,
        entity,
        attribute,
        value: existingRow.value,
        source_url: src.sourceUrl ?? null,
      });
      if (histErr) console.error("[smrtinfo] fact history insert:", histErr.message);
      const { error: supErr } = await db
        .from("info_facts")
        .update({ superseded_by: (inserted as { id: string }).id })
        .eq("id", existingRow.id);
      if (!supErr) result.factsSuperseded++;
    }
  }

  return result;
}
