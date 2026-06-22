export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { ExternalLink } from "lucide-react";
import { InboxTabs } from "@/components/platform/inbox/InboxTabs";
import { CorrectionsExportButton } from "@/components/smrttask/log/CorrectionsExportButton";

export default async function InboxPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("inbox");

  // Check if smrtTask is enabled for the user's active org. On app.smrtesy.com
  // the middleware strips smrt_org_id (no org context on the platform domain),
  // so the cookie is undefined here. Mirror the (app)/layout.tsx behavior:
  // fall back to the user's first org_members row. Without this, the inbox
  // page on app.* always hid the Suggestions tab, while the sidebar badge
  // (which goes through the Express backend with the localStorage X-Org-Id)
  // happily counted suggestions across that org — so the user saw "90" but
  // an empty tab.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let hasSmrtTask = false;

  if (user) {
    const cookieStore = await cookies();
    let activeOrgId = cookieStore.get("smrt_org_id")?.value ?? null;
    if (!activeOrgId) {
      const { data: memberships } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1);
      activeOrgId = memberships?.[0]?.org_id ?? null;
    }

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
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {/* Quick jump to the source log (opens on the platform domain in a
            new tab). Shown next to the title for both the Suggestions and
            Notifications views, which share this header. */}
        <a
          href="https://app.smrtesy.com/he/log"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("openLog")}
          title={t("openLog")}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        {/* Same corrections export as the log page, pinned to the trailing
            (left in RTL) edge of the title row. */}
        {hasSmrtTask && (
          <div className="ms-auto">
            <CorrectionsExportButton refreshKey={0} />
          </div>
        )}
      </div>
      <InboxTabs locale={locale} hasSmrtTask={hasSmrtTask} />
    </div>
  );
}
