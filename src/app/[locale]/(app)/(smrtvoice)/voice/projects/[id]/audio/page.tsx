import { AudioLineList } from "@/components/smrtvoice/AudioLineList";

export default async function ProjectAudioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6 space-y-6">
      <AudioLineList projectId={id} />
    </div>
  );
}
