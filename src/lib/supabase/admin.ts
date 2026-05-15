import { cache } from "react";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS. Use **only** in server-side
 * code that has already authorized the caller (e.g. admin pages gated by
 * a super-admin check). Never expose this to the browser.
 */
export function createAdminSupabaseClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Walks `auth.admin.listUsers` page-by-page and returns a map of
 * userId → email for every user in the project. The default per-page cap
 * is 1000 (Supabase max). Stops when a page returns fewer rows than
 * requested, so it scales to arbitrary sizes without an unbounded loop.
 *
 * Wrapped in `react.cache()` so multiple callers in the same server-render
 * (e.g. /admin/users and a child component both needing emails) share one
 * paginated walk instead of repeating it. Cache is per-request — different
 * page loads still get fresh data.
 *
 * Returns an empty Map if the service-role key is not configured.
 */
export interface UserEmailLookup {
  emails: Map<string, string>;
  /**
   * Why no emails were resolved, if applicable. Lets admin pages render a
   * banner instead of silently showing `—` for every user. `null` when
   * everything worked.
   */
  error: "service_role_missing" | "list_users_failed" | null;
}

export const listAllUserEmails = cache(
  async (): Promise<UserEmailLookup> => {
    const admin = createAdminSupabaseClient();
    const emails = new Map<string, string>();
    if (!admin) {
      console.warn(
        "[supabase/admin] SUPABASE_SERVICE_ROLE_KEY is not set; auth.users emails cannot be resolved. " +
          "Set it in the Vercel environment (Production scope) so /admin/users and /admin/apps/[slug]/services can show real addresses.",
      );
      return { emails, error: "service_role_missing" };
    }

    const perPage = 1000;
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) {
        console.error("[supabase/admin] auth.admin.listUsers failed:", error.message);
        return { emails, error: "list_users_failed" };
      }
      if (!data) break;
      for (const u of data.users) {
        if (u.email) emails.set(u.id, u.email);
      }
      if (data.users.length < perPage) break;
    }
    return { emails, error: null };
  },
);
