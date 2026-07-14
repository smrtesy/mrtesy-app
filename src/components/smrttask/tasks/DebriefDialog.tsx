"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export type ConductedIn = "claude" | "external" | "both" | "no_experiment";

/** The debrief payload sent as `debrief` on the completion request. Mirrors the
 *  server validator in server/src/modules/smrtplan/debrief.ts. */
export interface DebriefPayload {
  conducted_in: ConductedIn;
  claude_scored_confirmed?: boolean;
  claude_session_link?: string;
  claude_scores?: string;
  external_tool?: string;
  external_steps?: string;
  external_results?: string;
  external_scores?: string;
  no_experiment_reason?: string;
  q_worked_best: string;
  q_trick: string;
  q_surprise: string;
}

/**
 * Mandatory research-task debrief captured at completion time (docs
 * project-planning-protocol §5 "שלב ו"). The three fixed questions are always
 * required; the evidence fields depend on where the experiment ran. The server
 * enforces the same rules (422) — this dialog just makes the happy path pleasant.
 */
export function DebriefDialog({
  open,
  taskTitle,
  onClose,
  onConfirm,
}: {
  open: boolean;
  taskTitle: string;
  /** Cancel — the task is NOT completed. */
  onClose: () => void;
  /** Complete the task, saving `debrief`. */
  onConfirm: (debrief: DebriefPayload) => void;
}) {
  const t = useTranslations("tasks.debrief");
  const [conductedIn, setConductedIn] = useState<ConductedIn>("claude");
  const [claudeConfirmed, setClaudeConfirmed] = useState(false);
  const [claudeLink, setClaudeLink] = useState("");
  const [claudeScores, setClaudeScores] = useState("");
  const [tool, setTool] = useState("");
  const [steps, setSteps] = useState("");
  const [results, setResults] = useState("");
  const [extScores, setExtScores] = useState("");
  const [noReason, setNoReason] = useState("");
  const [workedBest, setWorkedBest] = useState("");
  const [trick, setTrick] = useState("");
  const [surprise, setSurprise] = useState("");

  useEffect(() => {
    if (!open) return;
    setConductedIn("claude");
    setClaudeConfirmed(false);
    setClaudeLink(""); setClaudeScores("");
    setTool(""); setSteps(""); setResults(""); setExtScores("");
    setNoReason("");
    setWorkedBest(""); setTrick(""); setSurprise("");
  }, [open]);

  const showClaude = conductedIn === "claude" || conductedIn === "both";
  const showExternal = conductedIn === "external" || conductedIn === "both";
  const showNone = conductedIn === "no_experiment";

  const valid = useMemo(() => {
    if (!workedBest.trim() || !trick.trim() || !surprise.trim()) return false;
    if (showClaude && (!claudeConfirmed || !claudeLink.trim() || !claudeScores.trim())) return false;
    if (showExternal && (!tool.trim() || !steps.trim() || !results.trim() || !extScores.trim())) return false;
    if (showNone && !noReason.trim()) return false;
    return true;
  }, [workedBest, trick, surprise, showClaude, claudeConfirmed, claudeLink, claudeScores, showExternal, tool, steps, results, extScores, showNone, noReason]);

  function submit() {
    if (!valid) return;
    const payload: DebriefPayload = {
      conducted_in: conductedIn,
      q_worked_best: workedBest.trim(),
      q_trick: trick.trim(),
      q_surprise: surprise.trim(),
    };
    if (showClaude) {
      payload.claude_scored_confirmed = true;
      payload.claude_session_link = claudeLink.trim();
      payload.claude_scores = claudeScores.trim();
    }
    if (showExternal) {
      payload.external_tool = tool.trim();
      payload.external_steps = steps.trim();
      payload.external_results = results.trim();
      payload.external_scores = extScores.trim();
    }
    if (showNone) payload.no_experiment_reason = noReason.trim();
    onConfirm(payload);
  }

  const options: ConductedIn[] = ["claude", "external", "both", "no_experiment"];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-start">{t("title")}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground" dir="auto">{t("hint")}</p>
        {taskTitle && <p className="truncate text-sm font-medium" dir="auto">{taskTitle}</p>}

        <div className="space-y-4 pt-1">
          {/* Where did the experiment run? */}
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium">{t("conductedIn.label")}</label>
            <div className="flex flex-wrap gap-2">
              {options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setConductedIn(opt)}
                  className={
                    "rounded-md border px-2.5 py-1 text-[12.5px] " +
                    (conductedIn === opt ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground")
                  }
                >
                  {t(`conductedIn.${opt === "no_experiment" ? "none" : opt}`)}
                </button>
              ))}
            </div>
          </div>

          {showClaude && (
            <div className="space-y-2 rounded-md border border-input p-2.5">
              <label className="flex items-start gap-2 text-[12.5px]" dir="auto">
                <input type="checkbox" className="mt-0.5" checked={claudeConfirmed} onChange={(e) => setClaudeConfirmed(e.target.checked)} />
                <span>{t("claude.confirm")}</span>
              </label>
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("claude.sessionLink")}</label>
                <Input value={claudeLink} onChange={(e) => setClaudeLink(e.target.value)} dir="auto" placeholder={t("claude.sessionLinkPh")} />
              </div>
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("claude.scores")}</label>
                <Textarea value={claudeScores} onChange={(e) => setClaudeScores(e.target.value)} rows={3} dir="auto" placeholder={t("claude.scoresPh")} />
              </div>
            </div>
          )}

          {showExternal && (
            <div className="space-y-2 rounded-md border border-input p-2.5">
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("external.tool")}</label>
                <Input value={tool} onChange={(e) => setTool(e.target.value)} dir="auto" placeholder={t("external.toolPh")} />
              </div>
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("external.steps")}</label>
                <Textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={3} dir="auto" placeholder={t("external.stepsPh")} />
              </div>
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("external.results")}</label>
                <Textarea value={results} onChange={(e) => setResults(e.target.value)} rows={2} dir="auto" placeholder={t("external.resultsPh")} />
              </div>
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">{t("external.scores")}</label>
                <Textarea value={extScores} onChange={(e) => setExtScores(e.target.value)} rows={2} dir="auto" placeholder={t("external.scoresPh")} />
              </div>
            </div>
          )}

          {showNone && (
            <div className="space-y-1">
              <label className="text-[11.5px] text-muted-foreground">{t("noExperiment.reason")}</label>
              <Textarea value={noReason} onChange={(e) => setNoReason(e.target.value)} rows={2} dir="auto" placeholder={t("noExperiment.reasonPh")} />
            </div>
          )}

          {/* The three fixed playbook questions — always required. */}
          <div className="space-y-2 border-t pt-3">
            <div className="space-y-1">
              <label className="text-[12.5px] font-medium">{t("q.workedBest")}</label>
              <Textarea value={workedBest} onChange={(e) => setWorkedBest(e.target.value)} rows={2} dir="auto" />
            </div>
            <div className="space-y-1">
              <label className="text-[12.5px] font-medium">{t("q.trick")}</label>
              <Textarea value={trick} onChange={(e) => setTrick(e.target.value)} rows={2} dir="auto" />
            </div>
            <div className="space-y-1">
              <label className="text-[12.5px] font-medium">{t("q.surprise")}</label>
              <Textarea value={surprise} onChange={(e) => setSurprise(e.target.value)} rows={2} dir="auto" />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={submit} disabled={!valid}>{t("submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
