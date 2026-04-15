"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

interface BriefApprovalProps {
  taskId: string;
  projectId: string;
  projectName: string;
  brief: {
    purpose?: string;
    target_audience?: string;
    current_status?: string;
    kpis?: string;
    systems?: unknown[];
    important_links?: unknown[];
  };
  onApproved: () => void;
}

export function BriefApproval({ taskId, projectId, projectName, brief, onApproved }: BriefApprovalProps) {
  const t = useTranslations("projects");
  const supabase = createClient();
  const [approving, setApproving] = useState(false);

  // Checklist items per doc section 12.5
  const checklist = [
    { key: "name_purpose", label: locale("he") ? "שם + מטרה" : "Name + Purpose", done: !!brief.purpose },
    { key: "contact", label: locale("he") ? "איש קשר" : "Contact person", done: (brief.systems || []).length > 0 },
    { key: "system", label: locale("he") ? "מערכת/workflow" : "System/workflow", done: (brief.systems || []).length > 0 },
    { key: "status", label: locale("he") ? "סטטוס" : "Status", done: !!brief.current_status },
  ];

  const allDone = checklist.every((c) => c.done);

  async function handleApprove() {
    setApproving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Lock CORE brief — mark as approved
      await supabase.from("project_briefs").update({
        updated_at: new Date().toISOString(),
      }).eq("project_id", projectId);

      // Mark the brief_review task as completed
      await supabase.from("tasks").update({
        status: "archived",
        completed_at: new Date().toISOString(),
        manually_verified: true,
      }).eq("id", taskId);

      toast.success(t("brief") + " approved");
      onApproved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApproving(false);
    }
  }

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-blue-500" />
          {t("brief")} — <span dir="auto">{projectName}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Minimal checklist */}
        <div className="space-y-1">
          {checklist.map((item) => (
            <div key={item.key} className="flex items-center gap-2 text-sm">
              {item.done ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <div className="h-4 w-4 rounded-full border-2 border-muted-foreground" />
              )}
              <span className={item.done ? "" : "text-muted-foreground"}>{item.label}</span>
            </div>
          ))}
        </div>

        {/* Brief preview */}
        {brief.purpose && (
          <p className="text-xs text-muted-foreground border-s-2 border-blue-300 ps-2" dir="auto">
            {brief.purpose}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleApprove}
            disabled={approving}
            size="sm"
            className="min-h-[48px] flex-1 gap-1"
          >
            <CheckCircle2 className="h-4 w-4" />
            {allDone ? t("brief") : t("brief")} {allDone ? "✓" : "(partial)"}
          </Button>
        </div>

        {!allDone && (
          <p className="text-xs text-muted-foreground">
            {checklist.filter((c) => !c.done).length} items incomplete — you can still approve
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Helper — in production this would use useLocale()
function locale(lang: string): boolean {
  if (typeof window !== "undefined") {
    return window.location.pathname.includes(`/${lang}/`);
  }
  return lang === "he";
}
