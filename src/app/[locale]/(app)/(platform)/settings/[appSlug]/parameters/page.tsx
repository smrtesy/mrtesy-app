import { redirect } from "next/navigation";

export default async function LegacyRedirect({
  params,
}: {
  params: Promise<{ locale: string; appSlug: string }>;
}) {
  const { locale, appSlug } = await params;
  redirect(`/${locale}/settings/apps/${appSlug}/parameters`);
}
