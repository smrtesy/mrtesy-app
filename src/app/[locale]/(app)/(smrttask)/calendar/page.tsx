// /calendar is now a view inside the Tasks page (the timeline toggle).
// Kept as a redirect so existing bookmarks / external links keep working.
import { redirect } from "next/navigation";

export default async function CalendarPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/tasks?view=calendar`);
}
