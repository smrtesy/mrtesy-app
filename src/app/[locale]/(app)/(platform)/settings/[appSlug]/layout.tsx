import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export default async function AppSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string; appSlug: string }>;
}) {
  const { locale, appSlug } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const { data: app } = await supabase
    .from("apps")
    .select("id")
    .eq("slug", appSlug)
    .maybeSingle();

  if (!app) redirect(`/${locale}/settings`);

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get("smrt_org_id")?.value;

  if (activeOrgId) {
    const { data: membership } = await supabase
      .from("app_memberships")
      .select("org_id")
      .eq("org_id", activeOrgId)
      .eq("app_id", app.id)
      .maybeSingle();

    if (!membership) redirect(`/${locale}/settings`);
  }

  return <>{children}</>;
}
