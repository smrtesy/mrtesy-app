import { redirect } from "next/navigation";

export default async function VoiceSettingsRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Stage G: the voice settings (engine form + lexicon) moved under the
  // studio's settings tab when smrtVoice was absorbed into smrtStudio.
  redirect(`/${locale}/settings/apps/smrtstudio`);
}
