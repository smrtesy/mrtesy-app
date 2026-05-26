import { CharacterDetails } from "@/components/smrtvoice/CharacterDetails";

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6 space-y-6">
      <CharacterDetails characterId={id} />
    </div>
  );
}
