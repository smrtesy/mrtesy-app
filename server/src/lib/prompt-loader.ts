/**
 * Load a prompt from ai_prompts table (user-editable via /admin/apps/smrtesy/prompts).
 * Falls back to null so callers can use their hardcoded default when nothing is saved.
 *
 * Supported template variables replaced before returning:
 *   {{user}}         → "Name at OrgName"
 *   {{userName}}     → user's display name
 *   {{gmailAddress}} → user's Gmail address (empty string if unknown)
 */

import { db } from "../db";
import type { UserPromptContext } from "./user-context";
import { formatIdentity } from "./user-context";

export async function loadPrompt(
  userId: string,
  promptKey: string,
  ctx?: UserPromptContext,
): Promise<string | null> {
  const { data } = await db
    .from("ai_prompts")
    .select("content")
    .eq("user_id", userId)
    .eq("prompt_key", promptKey)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.content) return null;

  let content: string = data.content;
  if (ctx) {
    content = content
      .replace(/\{\{user\}\}/g, formatIdentity(ctx))
      .replace(/\{\{userName\}\}/g, ctx.userName)
      .replace(/\{\{gmailAddress\}\}/g, ctx.gmailAddress ?? "");
  }
  return content;
}
