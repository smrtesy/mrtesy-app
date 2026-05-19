import { redirect } from "next/navigation";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Everyone — super-admins included — lands on /tasks, the daily working
  // surface. The previous "admins → /admin" carve-out meant that an admin
  // opening the app on their phone hit an ops dashboard (AI cost, error
  // counters) instead of their actual work. /admin is still one tap away
  // via the sidebar when they need it.
  redirect(`/${locale}/tasks`);
}
