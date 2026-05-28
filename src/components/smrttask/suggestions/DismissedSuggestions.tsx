"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

interface DismissedRow {
  id: string;
  title: string | null;
  title_he: string | null;
  priority: string | null;
  status_changed_at: string | null;
  updated_at: string | null;
  dismissal_reason_code: string | null;
  dismissal_reason_text: string | null;
  manually_verified: boolean | null;
}

export function DismissedSuggestions({
  locale,
  onChange,
}: {
  locale: string;
  onChange?: () => void;
}) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const supabase = createClient();
  const [rows, setRows] = useState<DismissedRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setRows([]);
        return;
      }
      const { data } = await supabase
        .from("tasks")
        .select("id, title, title_he, priority, status_changed_at, updated_at, dismissal_reason_code, dismissal_reason_text, manually_verified")
        .eq("user_id", user.id)
        .eq("status", "dismissed")
        .order("status_changed_at", { ascending: false, nullsFirst: false })
        .limit(200);
      setRows((data as DismissedRow[] | null) ?? []);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function handleRestore(id: string) {
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: {
          status: "inbox",
          dismissal_reason_code: null,
          dismissal_reason_text: null,
        },
      });
      toast.success(t("restored"));
      setRows((prev) => prev.filter((r) => r.id !== id));
      onChange?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Trash2 className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noDismissed")}</p>
      </div>
    );
  }

  const dtFmt = locale === "he" ? "he-IL" : "en-US";

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const title = (locale === "he" && row.title_he ? row.title_he : row.title) || "";
        const when = row.status_changed_at || row.updated_at;
        const whenLabel = when ? new Date(when).toLocaleString(dtFmt) : "";
        const reasonLabel = row.dismissal_reason_text || row.dismissal_reason_code || null;
        return (
          <Card key={row.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <div className="mt-1 rounded-full bg-red-100 p-1.5 shrink-0">
                    <Trash2 className="h-3.5 w-3.5 text-red-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {whenLabel && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("dismissedAt", { when: whenLabel })}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">
                        {row.manually_verified ? t("kindTask") : t("kindSuggestion")}
                      </Badge>
                      {row.priority && (
                        <Badge variant="secondary" className="text-[10px]">
                          {tTasks(`priority.${row.priority}`)}
                        </Badge>
                      )}
                    </div>
                    {reasonLabel && (
                      <p className="text-xs text-muted-foreground mt-1.5" dir="auto">
                        {t("dismissedReasonLabel")}: {reasonLabel}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-primary hover:bg-primary/10"
                    onClick={() => handleRestore(row.id)}
                    title={t("restoreToInbox")}
                    aria-label={t("restoreToInbox")}
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
