import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Super-admins land on /admin by default; everyone else on /tasks.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: row } = await supabase
      .from("super_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (row) redirect(`/${locale}/admin`);
  }

  redirect(`/${locale}/tasks`);
}
