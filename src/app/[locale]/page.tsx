import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Super-admins land on /admin by default; everyone else on /tasks.
  // Check both signals to match (app)/layout.tsx, api/auth/callback, and
  // middleware: super_admins row OR ADMIN_EMAIL env-var allowlist.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    let isAdmin = false;
    const { data: row } = await supabase
      .from("super_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (row) isAdmin = true;
    if (!isAdmin) {
      const adminEmails = (process.env.ADMIN_EMAIL || "")
        .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      isAdmin = adminEmails.includes(user.email?.toLowerCase() || "");
    }
    if (isAdmin) redirect(`/${locale}/admin`);
  }

  redirect(`/${locale}/tasks`);
}
