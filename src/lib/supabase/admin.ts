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
 * Returns an empty Map if the service-role key is not configured.
 */
export async function listAllUserEmails(): Promise<Map<string, string>> {
  const admin = createAdminSupabaseClient();
  const emails = new Map<string, string>();
  if (!admin) return emails;

  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) break;
    for (const u of data.users) {
      if (u.email) emails.set(u.id, u.email);
    }
    if (data.users.length < perPage) break;
  }
  return emails;
}
