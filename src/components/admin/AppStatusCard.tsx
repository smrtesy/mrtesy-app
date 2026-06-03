"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Loader2, Pencil, Check, X, Plus, Trash2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { type AppStage, STAGE_COLORS } from "./AppsRegistryClient";

const STAGES: AppStage[] = ["רעיון", "בניה", "טסט", "מאור", "לקוחות"];

interface AppStatus {
  app_slug: string;
  stage: AppStage;
  summary: string | null;
  next_steps: string[];
  blockers: string[];
  updated_at: string | null;
}

export function AppStatusCard({ slug }: { slug: string }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // draft state
  const [draftStage,     setDraftStage]     = useState<AppStage>("רעיון");
  const [draftSummary,   setDraftSummary]   = useState("");
  const [draftNext,      setDraftNext]      = useState<string[]>([]);
  const [draftBlockers,  setDraftBlockers]  = useState<string[]>([]);

  useEffect(() => {
    api<{ status: AppStatus }>(`/api/admin/apps/${slug}/status`, { noOrg: true })
      .then(({ status: s }) => setStatus(s))
      .catch(() => {});
  }, [slug]);

  function openEdit() {
    if (!status) return;
    setDraftStage(status.stage);
    setDraftSummary(status.summary ?? "");
    setDraftNext([...status.next_steps]);
    setDraftBlockers([...status.blockers]);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { status: updated } = await api<{ status: AppStatus }>(
        `/api/admin/apps/${slug}/status`,
        {
          method: "PATCH",
          noOrg: true,
          body: {
            stage:      draftStage,
            summary:    draftSummary.trim() || null,
            next_steps: draftNext.filter(Boolean),
            blockers:   draftBlockers.filter(Boolean),
          },
        },
      );
      setStatus(updated);
      setEditing(false);
      toast.success("סטטוס עודכן");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!status) {
    return <div className="h-40 rounded-lg bg-muted animate-pulse" />;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span>סטטוס פיתוח</span>
          {!editing && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={openEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {editing ? (
          <>
            {/* Stage selector */}
            <div>
              <p className="text-xs font-medium mb-1.5">שלב</p>
              <div className="flex gap-1.5 flex-wrap">
                {STAGES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setDraftStage(s)}
                    className={`rounded border px-3 py-1 text-sm font-medium transition-all ${
                      draftStage === s
                        ? STAGE_COLORS[s] + " ring-2 ring-offset-1 ring-current"
                        : "bg-background text-muted-foreground border-border hover:border-foreground"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary */}
            <div>
              <p className="text-xs font-medium mb-1">סיכום — מה המצב עכשיו</p>
              <Textarea
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
                placeholder="תאר בשפה פשוטה מה בנוי ומה הכיוון..."
                className="min-h-[80px] text-sm"
                dir="rtl"
              />
            </div>

            {/* Next steps */}
            <div>
              <p className="text-xs font-medium mb-1">מה הבא</p>
              <div className="space-y-1.5">
                {draftNext.map((step, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      value={step}
                      onChange={(e) => {
                        const updated = [...draftNext];
                        updated[i] = e.target.value;
                        setDraftNext(updated);
                      }}
                      className="text-sm h-8"
                      dir="rtl"
                    />
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground"
                      onClick={() => setDraftNext(draftNext.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="gap-1.5 text-xs h-7"
                  onClick={() => setDraftNext([...draftNext, ""])}>
                  <Plus className="h-3 w-3" /> הוסף שלב
                </Button>
              </div>
            </div>

            {/* Blockers */}
            <div>
              <p className="text-xs font-medium mb-1 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 text-status-warn" />
                חוסמים
              </p>
              <div className="space-y-1.5">
                {draftBlockers.map((b, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      value={b}
                      onChange={(e) => {
                        const updated = [...draftBlockers];
                        updated[i] = e.target.value;
                        setDraftBlockers(updated);
                      }}
                      className="text-sm h-8"
                      dir="rtl"
                    />
                    <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground"
                      onClick={() => setDraftBlockers(draftBlockers.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="gap-1.5 text-xs h-7"
                  onClick={() => setDraftBlockers([...draftBlockers, ""])}>
                  <Plus className="h-3 w-3" /> הוסף חוסם
                </Button>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                שמור
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Read view */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`inline-flex items-center rounded border px-3 py-1 text-sm font-medium ${STAGE_COLORS[status.stage]}`}>
                {status.stage}
              </span>
              {status.updated_at && (
                <span className="text-xs text-muted-foreground">
                  עודכן {new Date(status.updated_at).toLocaleDateString("he-IL")}
                </span>
              )}
            </div>

            {status.summary && (
              <p className="text-sm leading-relaxed" dir="rtl">{status.summary}</p>
            )}

            {status.next_steps.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">מה הבא</p>
                <ul className="space-y-1">
                  {status.next_steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm" dir="rtl">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {status.blockers.length > 0 && (
              <div className="rounded-lg border border-status-warn/30 bg-status-warn-bg p-3 space-y-1">
                <p className="text-xs font-medium text-status-warn flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> חוסמים
                </p>
                {status.blockers.map((b, i) => (
                  <p key={i} className="text-sm text-status-warn" dir="rtl">• {b}</p>
                ))}
              </div>
            )}

            {!status.summary && status.next_steps.length === 0 && (
              <p className="text-sm text-muted-foreground cursor-pointer hover:text-foreground" onClick={openEdit}>
                לחץ על העיפרון כדי להוסיף סטטוס...
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
