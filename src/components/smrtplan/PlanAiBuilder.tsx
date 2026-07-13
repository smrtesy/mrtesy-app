"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Sparkles, Loader2, ArrowLeft, ClipboardList } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface ProposalTask {
  key: string;
  stage?: string;
  title: string;
  estimated_hours?: number;
  ai_tier?: "full" | "assist" | "human" | null;
  is_decision?: boolean;
  definition_of_done?: string;
}
interface Proposal {
  plan?: { title_he?: string; title_en?: string; goal?: string; kind?: string };
  daily_minutes?: number | null;
  stages?: { key: string; title: string }[];
  tasks?: ProposalTask[];
  premortem?: string;
}

/**
 * In-app AI plan-builder (docs/smrtplan-focus-integration.md §7 route A).
 * Describe a project + daily minutes → Sonnet proposes a §13 plan → the user
 * reviews and creates it as a draft. Reassignment to teammates happens after,
 * in the plan detail (every task is created assigned to the creator).
 */
export function PlanAiBuilder({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (planId: string) => void;
}) {
  const t = useTranslations("planAiBuilder");
  const tb = useTranslations("tasks.buildDay");
  const [phase, setPhase] = useState<"input" | "loading" | "review">("input");
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPhase("input"); setDescription(""); setMinutes(""); setProposal(null); setBusy(false);
  }
  function close() { reset(); onClose(); }

  async function generate() {
    if (description.trim().length < 10) { toast.error(t("descTooShort")); return; }
    setPhase("loading");
    try {
      const mins = parseInt(minutes, 10);
      const { proposal: p } = await api<{ proposal: Proposal }>("/api/plans/ai-build", {
        method: "POST",
        body: { description: description.trim(), daily_minutes: Number.isInteger(mins) && mins > 0 ? mins : undefined },
      });
      setProposal(p);
      setPhase("review");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      setPhase("input");
    }
  }

  async function create() {
    if (!proposal) return;
    setBusy(true);
    try {
      const { plan } = await api<{ plan: { id: string } }>("/api/plans/ai-build/commit", { method: "POST", body: proposal });
      toast.success(t("created"));
      onCreated(plan.id);
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      setBusy(false);
    }
  }

  const tasks = proposal?.tasks ?? [];
  const totalHours = tasks.reduce((s, tk) => s + (Number(tk.estimated_hours) || 0), 0);
  const tierLabel = (tier?: string | null) =>
    tier === "full" ? "🤖" : tier === "assist" ? "🤝" : tier === "human" ? "👤" : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-start">
            <Sparkles className="h-4 w-4 text-primary" /> {t("title")}
          </DialogTitle>
        </DialogHeader>

        {phase === "input" && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{t("descLabel")}</span>
              <Textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descPlaceholder")} dir="auto" autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{t("minutesLabel")}</span>
              <Input type="number" min={1} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} dir="ltr" />
            </label>
          </div>
        )}

        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm" dir="auto">{t("generating")}</p>
          </div>
        )}

        {phase === "review" && proposal && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{t("planTitle")}</span>
              <Input value={proposal.plan?.title_he ?? ""} dir="auto"
                onChange={(e) => setProposal({ ...proposal, plan: { ...proposal.plan, title_he: e.target.value } })} />
            </label>
            {proposal.plan?.goal && <p className="text-[12.5px] text-muted-foreground" dir="auto">{proposal.plan.goal}</p>}
            <div className="flex flex-wrap gap-2 text-[11.5px] text-muted-foreground">
              <span className="rounded-full bg-secondary px-2 py-0.5">{t("tasksCount", { n: tasks.length })}</span>
              <span className="rounded-full bg-secondary px-2 py-0.5">{t("hoursTotal", { n: Math.round(totalHours * 10) / 10 })}</span>
              {(proposal.stages?.length ?? 0) > 0 && (
                <span className="rounded-full bg-secondary px-2 py-0.5">{t("stagesCount", { n: proposal.stages!.length })}</span>
              )}
            </div>
            <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border p-2">
              {tasks.map((tk) => (
                <div key={tk.key} className="flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5 text-[12.5px]">
                  <ClipboardList className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">{tk.title}</span>
                  {tk.is_decision && <span className="shrink-0 rounded bg-status-warn-bg px-1 text-[10px] text-status-warn">{t("decision")}</span>}
                  {tk.ai_tier && <span className="shrink-0" title={tk.ai_tier}>{tierLabel(tk.ai_tier)}</span>}
                  {tk.estimated_hours != null && (
                    <span className="shrink-0 tabular-nums text-muted-foreground" dir="ltr">{tk.estimated_hours}h</span>
                  )}
                </div>
              ))}
            </div>
            {proposal.premortem && (
              <p className="rounded-md bg-status-warn-bg/50 px-2.5 py-1.5 text-[11.5px] text-foreground/80" dir="auto">
                ⚠ {proposal.premortem}
              </p>
            )}
            <p className="text-[11px] italic text-muted-foreground" dir="auto">{t("reassignHint")}</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {phase === "review" ? (
            <>
              <Button variant="ghost" className="gap-1" onClick={() => setPhase("input")} disabled={busy}>
                <ArrowLeft className="h-4 w-4" /> {t("back")}
              </Button>
              <Button onClick={create} disabled={busy || !(proposal?.plan?.title_he ?? "").trim()}>
                {busy ? t("creating") : t("create")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={phase === "loading"}>{tb("close")}</Button>
              <Button className={cn("gap-1")} onClick={generate} disabled={phase === "loading"}>
                <Sparkles className="h-4 w-4" /> {t("generate")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
