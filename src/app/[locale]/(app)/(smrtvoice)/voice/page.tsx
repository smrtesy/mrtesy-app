import { redirect } from "next/navigation";

/**
 * Stage G (docs/studio-build-plan.md): smrtVoice was absorbed into smrtStudio.
 * The voice front door is now the studio's project list — voice work starts
 * from a project's voice tab. The deep screens (/voice/projects/:id,
 * /voice/scripts/:id, /voice/characters, /voice/library …) keep their URLs and
 * keep working; only the app's home moved.
 */
export default async function VoiceHomeRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/studio/projects`);
}
