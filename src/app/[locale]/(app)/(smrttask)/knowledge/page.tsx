export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { KnowledgeCenter } from "@/components/smrttask/knowledge/KnowledgeCenter";
import { ResourceGuard } from "@/components/platform/permissions/ResourceGuard";

export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  return (
    <ResourceGuard
      resourceKey="smrttask.screen.knowledge"
      labelKey="permissions.resources.smrttask_screen_knowledge"
    >
      <KnowledgeCenter />
    </ResourceGuard>
  );
}
