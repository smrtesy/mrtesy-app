import { ClaudeRunsClient } from "@/components/claude/ClaudeRunsClient";

export default async function ClaudeRunsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <ClaudeRunsClient />;
}
