import { MyTasksClient } from "@/components/smrtplan/MyTasksClient";

export const dynamic = "force-dynamic";

export default async function MyPlanTasksPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <MyTasksClient locale={locale} />;
}
