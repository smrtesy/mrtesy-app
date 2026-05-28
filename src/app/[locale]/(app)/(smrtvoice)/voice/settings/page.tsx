import { redirect } from "next/navigation";

export default async function VoiceSettingsRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/settings/apps/smrtvoice`);
}
