/**
 * smrtCRM — public inbound contact ingest (token-authenticated, UNAUTHENTICATED
 * by JWT). Mounted before the auth guards.
 *
 * CRM-1: an external system POSTs a contact to /api/crm/ingest/:token. The token
 * identifies the api_connection (and thus the org + the tag to auto-apply).
 * Contacts go through the same upsertContact dedup path as every other source.
 *
 *   POST /api/crm/ingest/:token
 *   body: { phone?, email?, first_name?, last_name?, notes?, custom_fields? }
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { emitEvent, notifyError } from "../../lib/platform";
import { upsertContact, assignTag } from "./contacts-service";

const router = Router();

router.post("/crm/ingest/:token", async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token) return res.status(401).json({ error: "missing token" });

  const { data: conn } = await db
    .from("smrtcrm_api_connections")
    .select("org_id, tag_id")
    .eq("token", token)
    .maybeSingle();
  if (!conn) return res.status(403).json({ error: "invalid token" });

  const orgId = conn.org_id as string;
  const body = (req.body ?? {}) as {
    phone?: string; email?: string; first_name?: string; last_name?: string;
    notes?: string; custom_fields?: Record<string, unknown>;
  };
  if (!body.phone && !body.email && !body.first_name) {
    return res.status(400).json({ error: "at least one of phone, email or first_name is required" });
  }

  try {
    const actorId = await ingestUser(orgId);
    const result = await upsertContact(orgId, actorId, {
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      notes: body.notes ?? null,
      custom_fields: body.custom_fields ?? {},
      source: "api",
    });
    if (conn.tag_id) await assignTag(orgId, result.id, conn.tag_id as string);

    await emitEvent(
      orgId,
      "smrtcrm",
      result.outcome === "created" ? "contact.created" : "contact.merged",
      "contact",
      result.id,
      { source: "api" },
    );
    res.status(result.outcome === "created" ? 201 : 200).json({ ok: true, outcome: result.outcome });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await notifyError(orgId, "smrtcrm", { title: "API ingest failed", body: msg });
    res.status(500).json({ error: msg });
  }
});

// created_by on contacts is NOT NULL FK → use the org owner as the actor for
// API-ingested rows (there's no logged-in user on this public endpoint).
async function ingestUser(orgId: string): Promise<string> {
  const { data } = await db.from("organizations").select("created_by").eq("id", orgId).maybeSingle();
  const owner = data?.created_by as string | undefined;
  if (!owner) throw new Error("organization has no owner to attribute the ingested contact to");
  return owner;
}

export default router;
