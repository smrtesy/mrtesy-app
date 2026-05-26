import { ScriptViewer } from "@/components/smrtvoice/ScriptViewer";

export default async function ProjectScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6 space-y-6">
      <ScriptViewer projectId={id} />
    </div>
  );
}
