"use client";

import { Button } from "@/components/ui/button";

export function BuildBriefButton({ projectName }: { projectName: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2"
      onClick={() => {
        window.open(
          `https://claude.ai/new?q=${encodeURIComponent(
            `Build a project brief for "${projectName}". Include: purpose, target audience, current status, key people, systems, and weekly workflow.`
          )}`,
          "_blank"
        );
      }}
    >
      Build Brief with Claude
    </Button>
  );
}
