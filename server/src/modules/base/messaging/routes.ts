/**
 * Messaging routes — base module (Phase 5).
 *
 *   GET    /conversations                          list conversations in active org (newest activity first)
 *   POST   /conversations                          start 1-on-1 (body: { with_user_id }) or group (body: { member_ids, title })
 *   GET    /conversations/:id                      get conversation + members
 *   GET    /conversations/:id/messages?before=ts   paged message history (newest first)
 *   POST   /conversations/:id/messages             send a message  body: { content }
 *   POST   /conversations/:id/read                 mark conversation as read up to now (sets last_read_at = now)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg } from "../../../middleware";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Ensure the caller is a member of the conversation AND it's in the active org.
 * Returns the conversation row or null (and writes the response on failure).
 */
async function loadConversationOr404(
  conversationId: string,
  orgId: string,
  userId: string,
  res: Response,
) {
  const { data: conv } = await db
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!conv) {
    res.status(404).json({ error: "conversation not found in this org" });
    return null;
  }

  const { data: member } = await db
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!member) {
    res.status(403).json({ error: "you are not a member of this conversation" });
    return null;
  }

  return conv;
}

/** Find an existing 1-on-1 conversation between two users in an org. */
async function findExistingDM(orgId: string, a: string, b: string): Promise<string | null> {
  // Get conversations user A is in that are 1-on-1 in this org
  const { data: aConvs } = await db
    .from("conversation_members")
    .select("conversation_id, conversations!inner(id, is_group, organization_id)")
    .eq("user_id", a);

  for (const row of aConvs ?? []) {
    const conv = Array.isArray(row.conversations) ? row.conversations[0] : row.conversations;
    if (!conv || conv.is_group || conv.organization_id !== orgId) continue;

    // Check user B is also a member of this conv
    const { data: bMember } = await db
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", row.conversation_id)
      .eq("user_id", b)
      .maybeSingle();
    if (bMember) return row.conversation_id;
  }
  return null;
}

// ── routes ─────────────────────────────────────────────────────────────────

/** GET /conversations */
router.get("/conversations", requireAuth, requireOrg, async (req: Request, res: Response) => {
  // Get conversation IDs the user is in
  const { data: memberships } = await db
    .from("conversation_members")
    .select("conversation_id, last_read_at")
    .eq("user_id", req.user!.id);

  const convIds = (memberships ?? []).map((m) => m.conversation_id);
  if (convIds.length === 0) return res.json({ conversations: [] });

  // Fetch the conversation rows in this org
  const { data: convs, error } = await db
    .from("conversations")
    .select("*")
    .eq("organization_id", req.org!.id)
    .in("id", convIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });

  // Attach the caller's last_read_at to each
  const lastReadMap = new Map((memberships ?? []).map((m) => [m.conversation_id, m.last_read_at]));
  const result = (convs ?? []).map((c) => ({ ...c, my_last_read_at: lastReadMap.get(c.id) ?? null }));

  res.json({ conversations: result });
});

/** POST /conversations  body: { with_user_id } | { member_ids: string[], title?: string } */
router.post("/conversations", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const { with_user_id, member_ids, title } = req.body ?? {};

  // 1-on-1 mode
  if (with_user_id && typeof with_user_id === "string") {
    if (with_user_id === req.user!.id) {
      return res.status(400).json({ error: "cannot start a DM with yourself" });
    }
    // Verify the other user is in the org
    const { data: peer } = await db
      .from("org_members")
      .select("user_id")
      .eq("org_id", req.org!.id)
      .eq("user_id", with_user_id)
      .maybeSingle();
    if (!peer) return res.status(404).json({ error: "user is not in this org" });

    // Return existing DM if one already exists
    const existing = await findExistingDM(req.org!.id, req.user!.id, with_user_id);
    if (existing) return res.json({ conversation: { id: existing }, existing: true });

    // Create new 1-on-1
    const { data: conv, error: cErr } = await db
      .from("conversations")
      .insert({
        organization_id: req.org!.id,
        is_group: false,
        created_by: req.user!.id,
      })
      .select("*")
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });

    const { error: mErr } = await db.from("conversation_members").insert([
      { conversation_id: conv.id, user_id: req.user!.id },
      { conversation_id: conv.id, user_id: with_user_id },
    ]);
    if (mErr) {
      await db.from("conversations").delete().eq("id", conv.id);
      return res.status(500).json({ error: `member insert: ${mErr.message}` });
    }

    return res.status(201).json({ conversation: conv, existing: false });
  }

  // Group mode
  if (Array.isArray(member_ids) && member_ids.length >= 1) {
    // De-dupe + remove caller (we add them automatically)
    const peers = Array.from(new Set(member_ids.filter((id: string) => id !== req.user!.id)));
    if (peers.length === 0) {
      return res.status(400).json({ error: "group needs at least one other member" });
    }
    // Verify all peers are in the org
    const { data: peerRows } = await db
      .from("org_members")
      .select("user_id")
      .eq("org_id", req.org!.id)
      .in("user_id", peers);
    const verified = new Set((peerRows ?? []).map((r) => r.user_id));
    const missing = peers.filter((p) => !verified.has(p));
    if (missing.length > 0) {
      return res.status(400).json({ error: `users not in org: ${missing.join(", ")}` });
    }

    const { data: conv, error: cErr } = await db
      .from("conversations")
      .insert({
        organization_id: req.org!.id,
        is_group: true,
        title: typeof title === "string" ? title.trim() : null,
        created_by: req.user!.id,
      })
      .select("*")
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });

    const memberRows = [req.user!.id, ...peers].map((uid) => ({
      conversation_id: conv.id,
      user_id: uid,
    }));
    const { error: mErr } = await db.from("conversation_members").insert(memberRows);
    if (mErr) {
      await db.from("conversations").delete().eq("id", conv.id);
      return res.status(500).json({ error: `member insert: ${mErr.message}` });
    }

    return res.status(201).json({ conversation: conv });
  }

  return res.status(400).json({ error: "provide with_user_id (1-on-1) or member_ids[] (group)" });
});

/** GET /conversations/:id */
router.get("/conversations/:id", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const conv = await loadConversationOr404(req.params.id, req.org!.id, req.user!.id, res);
  if (!conv) return;

  const { data: members } = await db
    .from("conversation_members")
    .select("user_id, joined_at, last_read_at")
    .eq("conversation_id", conv.id);

  res.json({ conversation: conv, members: members ?? [] });
});

/** GET /conversations/:id/messages?before=ISO&limit=50 */
router.get("/conversations/:id/messages", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const conv = await loadConversationOr404(req.params.id, req.org!.id, req.user!.id, res);
  if (!conv) return;

  const { before, limit } = req.query;
  const n = Math.min(parseInt((limit as string) ?? "50", 10) || 50, 200);

  let q = db
    .from("messages")
    .select("*")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(n);
  if (typeof before === "string") q = q.lt("created_at", before);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data ?? [] });
});

/** POST /conversations/:id/messages */
router.post("/conversations/:id/messages", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const { content } = req.body ?? {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  const conv = await loadConversationOr404(req.params.id, req.org!.id, req.user!.id, res);
  if (!conv) return;

  const { data, error } = await db
    .from("messages")
    .insert({
      conversation_id: conv.id,
      sender_id: req.user!.id,
      content: content.trim(),
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: data });
});

/** POST /conversations/:id/read — mark as read up to now */
router.post("/conversations/:id/read", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const conv = await loadConversationOr404(req.params.id, req.org!.id, req.user!.id, res);
  if (!conv) return;

  const { error } = await db
    .from("conversation_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conv.id)
    .eq("user_id", req.user!.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
