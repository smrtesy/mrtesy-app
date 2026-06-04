export const dynamic = "force-dynamic";

import { CampaignDetailClient } from "@/components/smrtreach/CampaignDetailClient";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6">
      <CampaignDetailClient campaignId={id} />
    </div>
  );
}
