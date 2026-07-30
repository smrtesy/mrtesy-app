import { StudioProject } from "@/components/smrtstudio/StudioProject";

export const dynamic = "force-dynamic";

export default async function StudioProjectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  return <StudioProject projectId={id} />;
}
