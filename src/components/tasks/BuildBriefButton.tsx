"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface BuildBriefButtonProps {
  projectName: string;
  /** If provided, calls backend Part 4 build_brief instead of opening Claude.ai */
  projectId?: string;
}

export function BuildBriefButton({ projectName, projectId }: BuildBriefButtonProps) {
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("Not signed in"); return; }

      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
      const res = await fetch(`${backendUrl}/api/sync/part4/build_brief`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ project_id: projectId }),
      });

      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Failed");

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
