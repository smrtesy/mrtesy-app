// The calendar view was removed with the desk redesign — /calendar now lands
// on the tasks desk. Kept as a redirect so existing bookmarks keep working.
import { redirect } from "next/navigation";

export default async function CalendarPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/tasks`);
}
