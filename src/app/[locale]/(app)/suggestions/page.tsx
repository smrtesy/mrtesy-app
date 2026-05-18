import { redirect } from "next/navigation";

export default async function SuggestionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/inbox`);
}
