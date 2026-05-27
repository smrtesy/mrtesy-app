/**
 * POST /api/knowledge/save
 * Save an approved answer to the user's knowledge base.
 *
 * The question is taken from the task's source message (the incoming email /
 * WhatsApp text); the answer is the user-approved/edited draft. Next time a
 * semantically-similar question arrives, the action executor reuses this answer.
 *
 * Body: { task_id, answer }
 */

import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { saveKnowledge } from "../../../lib/knowledge";

const router = Router();

async function getUserId(req: Request): Promise<string | null> {
  const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

router.post("/save", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { task_id, answer } = req.body ?? {};
  if (!task_id || typeof answer !== "string" || !answer.trim()) {
    return res.status(400).json({ error: "task_id and answer required" });
  }

  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("title, title_he, description, source_message_id")
    .eq("id", task_id)
    .eq("user_id", userId)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  const { data: sourceMsg } = task.source_message_id
    ? await db
        .from("source_messages")
        .select("raw_content, body_text, source_type")
        .eq("id", task.source_message_id)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };

  const original = sourceMsg?.raw_content ?? sourceMsg?.body_text ?? "";
  const question = `${task.title_he ?? task.title}\n${original}`.trim();

  const result = await saveKnowledge({
    userId,
    question,
    answer,
    sourceType: sourceMsg?.source_type ?? null,
    taskId: task_id,
  });

  if ("error" in result) {
    const status = result.error === "embedding_unavailable" ? 503 : 500;
    return res.status(status).json({ error: result.error });
  }

  res.json({ id: result.id, ok: true });
});

export default router;
