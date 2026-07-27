import { ClaudeChat } from "@/components/claude/ClaudeChat";

/**
 * /claude — Claude as a screen of the product, not a tool you leave the app for
 * (docs/claude-console/app-integration-plan.md).
 *
 * It moved out of /admin so the sidebar's primary button can open it directly. The
 * Express routes it calls still require a super-admin: a run executes commands on
 * our host with our GitHub token, and relocating a screen is not a reason to widen
 * that. The sidebar only shows the button to an admin for the same reason.
 */
export default async function ClaudePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <ClaudeChat />;
}
