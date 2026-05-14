import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/AdminNav";

/**
 * Gates the entire /admin section. Access granted if EITHER:
 *   1. User has a row in super_admins (canonical DB role)
 *   2. User's email is in ADMIN_EMAIL env (permanent fallback)
 *
 * The same logic runs on the server (this layout) AND in the Express
 * requireSuperAdmin middleware — so even if someone bypassed the layout,
 * the API calls would still 403.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  // 1. DB check (self-read policy lets the user see their own row)
  const { data: row } = await supabase
    .from("super_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const hasAccess = !!row || adminEmails.includes(user.email?.toLowerCase() || "");

  if (!hasAccess) redirect(`/${locale}`);

  return (
    <>
      <AdminNav />
      {children}
    </>
  );
}
