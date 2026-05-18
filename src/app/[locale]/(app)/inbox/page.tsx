export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { InboxTabs } from "@/components/inbox/InboxTabs";

export default async function InboxPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("inbox");

  // Check if the active org has smrtTask enabled
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let hasSmrtTask = false;

  if (user) {
    const cookieStore = await cookies();
    const activeOrgId = cookieStore.get("smrt_org_id")?.value;
    if (activeOrgId) {
      const { data: app } = await supabase
        .from("apps")
        .select("id")
        .eq("slug", "smrttask")
        .maybeSingle();
      if (app) {
        const { data: membership } = await supabase
          .from("app_memberships")
          .select("org_id")
          .eq("org_id", activeOrgId)
          .eq("app_id", app.id)
          .maybeSingle();
        hasSmrtTask = !!membership;
      }
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <InboxTabs locale={locale} hasSmrtTask={hasSmrtTask} />
    </div>
  );
}
