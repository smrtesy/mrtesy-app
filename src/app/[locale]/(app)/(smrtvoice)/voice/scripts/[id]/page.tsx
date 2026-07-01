import { ScriptOverview } from "@/components/smrtvoice/ScriptOverview";

export default async function ScriptPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6 space-y-6">
      <ScriptOverview scriptId={id} />
    </div>
  );
}
