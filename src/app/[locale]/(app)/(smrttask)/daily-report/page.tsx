export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { DailyReportClient } from "@/components/smrttask/dailyreport/DailyReportClient";
import { ResourceGuard } from "@/components/platform/permissions/ResourceGuard";

export default async function DailyReportPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  return (
    <ResourceGuard
      resourceKey="smrttask.screen.daily-report"
      labelKey="permissions.resources.smrttask_screen_daily_report"
    >
      <DailyReportClient />
    </ResourceGuard>
  );
}
