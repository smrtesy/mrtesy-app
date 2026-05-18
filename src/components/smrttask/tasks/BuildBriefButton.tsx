"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface BuildBriefButtonProps {
  projectName: string;
  /** If provided, calls backend Part 4 build_brief instead of opening Claude.ai */
  projectId?: string;
}

export function BuildBriefButton({ projectName, projectId }: BuildBriefButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    if (!projectId) {
      // Fallback: open Claude.ai (legacy behaviour)
      window.open(
        `https://claude.ai/new?q=${encodeURIComponent(
          `Build a project brief for "${projectName}". Include: purpose, target audience, current status, key people, systems, and weekly workflow.`
        )}`,
        "_blank",
      );
      return;
    }

    setLoading(true);
    try {
      await api<{ ok: boolean }>("/api/sync/part4/build_brief", {
        method: "POST",
        body: { project_id: projectId },
      });

      toast.success("Brief building started — refresh in a moment to see extracted facts");
      // Refresh to show new pending_facts
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error building brief");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {loading ? "Building…" : "Build Brief with AI"}
    </Button>
  );
}
