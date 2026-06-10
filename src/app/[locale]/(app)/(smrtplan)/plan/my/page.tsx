// "My plan tasks" merged into the unified tasks desk (/tasks) — plan tasks
// appear there with the 📋 context panel, blocked state and effective
// deadlines. Kept as a redirect so bookmarks and the old nav keep working.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MyPlanTasksPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/tasks`);
}
