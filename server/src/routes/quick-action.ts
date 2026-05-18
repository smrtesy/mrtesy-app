/**
 * POST /api/quick-action
 *
 * Free-form Claude call used by the UI for one-off jobs that aren't task-bound
 * actions (which go through /api/actions/execute).
 *
 * Replaces the missing `supabase/functions/quick-action` edge function that
 * `SmartTaskInput` and `DriveSearch.handleSummarize` previously pointed at.
 *
 * Body:
 *   { prompt: string, action_label?: string, max_tokens?: number, model?: "haiku"|"sonnet"|"opus" }
 * Returns:
 *   { result: string }
 */

import { Router, Request, Response } from "express";
import { db } from "../db";
import { simpleCall, type ModelKey } from "../anthropic";

const router = Router();

async function getUserId(req: Request): Promise<string | null> {
  const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

router.post("/", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { prompt, max_tokens, model } = (req.body ?? {}) as {
    prompt?: unknown;
    max_tokens?: unknown;
    model?: unknown;
  };

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }

  const allowedModels: ModelKey[] = ["haiku", "sonnet", "opus"];
  const chosenModel: ModelKey = allowedModels.includes(model as ModelKey)
    ? (model as ModelKey)
    : "sonnet";

  const maxTokens =
    typeof max_tokens === "number" && max_tokens > 0 && max_tokens <= 4096
      ? max_tokens
      : 1024;

  try {
    const { content } = await simpleCall(
      chosenModel,
      "You are a helpful assistant. Follow the user's instructions precisely.",
      prompt.slice(0, 8000),
      maxTokens,
    );
    return res.json({ result: content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

export default router;
