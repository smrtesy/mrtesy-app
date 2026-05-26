import { ProjectOverview } from "@/components/smrtvoice/ProjectOverview";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6 space-y-6">
      <ProjectOverview projectId={id} />
    </div>
  );
}
