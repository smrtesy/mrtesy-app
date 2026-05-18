/**
 * Per-user prompt context used by Claude calls (classifier, action executor,
 * style learning, project suggester, etc.).
 *
 * Replaces hard-coded "Chanoch Chaskind / Maor nonprofit" strings that lived
 * inside system prompts. Every AI call should template these in instead.
 */

import { db } from "../db";

export interface UserPromptContext {
  /** Display name from user_settings.display_name → user_metadata.full_name → email local-part → "the user". */
  userName: string;
  /** Active org name. Empty string if no org context. */
  orgName: string;
  /** First connected Gmail address, used by part0 to scope the writing-style search. Empty if none. */
  gmailAddress: string;
}

interface UserSettingsRow {
  display_name?: string | null;
}

interface AuthUser {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export async function getUserPromptContext(
  userId: string,
  orgId?: string | null,
): Promise<UserPromptContext> {
  const [{ data: settings }, { data: userRes }, { data: cred }] = await Promise.all([
    db.from("user_settings").select("display_name").eq("user_id", userId).maybeSingle(),
    db.auth.admin.getUserById(userId),
    db
      .from("user_credentials")
      .select("email")
      .eq("user_id", userId)
      .eq("service", "gmail")
      .maybeSingle(),
  ]);

  const s = settings as UserSettingsRow | null;
  const u = userRes?.user as AuthUser | undefined;

  const fromMeta =
    (u?.user_metadata?.full_name as string | undefined) ??
    (u?.user_metadata?.name as string | undefined);
  const fromEmail = u?.email ? u.email.split("@")[0] : undefined;

  const userName = s?.display_name?.trim() || fromMeta || fromEmail || "the user";

  let orgName = "";
  if (orgId) {
    const { data: org } = await db
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    orgName = (org?.name as string | undefined) ?? "";
  }

  const credAny = cred as { email?: string | null } | null;
  const gmailAddress = credAny?.email ?? u?.email ?? "";

  return { userName, orgName, gmailAddress };
}

/**
 * Format the user's identity for inlining into a system prompt.
 * Examples:
 *   { userName: "Sarah", orgName: "Acme" } → "Sarah at Acme"
 *   { userName: "Sarah", orgName: "" }     → "Sarah"
 */
export function formatIdentity(ctx: UserPromptContext): string {
  if (ctx.orgName) return `${ctx.userName} at ${ctx.orgName}`;
  return ctx.userName;
}
