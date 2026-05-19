"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Save, DollarSign } from "lucide-react";

interface UserDetailResponse {
  user: { id: string; email: string | null };
  settings: { daily_ai_budget_usd: number | null } | null;
}

const DEFAULT_BUDGET = 1.0;

/**
 * Lives only on the super-admin /admin/users/[id] page. The user themselves
 * cannot see or change their own budget — /me/settings PATCH no longer
 * whitelists daily_ai_budget_usd. The new PATCH /admin/users/:id/budget
 * route uses the service-role client, which bypasses user_isolation RLS so
 * it can write to another user's row.
 */
export function UserAiBudgetEditor({ userId }: { userId: string }) {
  const t = useTranslations("adminUserBudget");
  const [budget, setBudget] = useState<number>(DEFAULT_BUDGET);
  const [original, setOriginal] = useState<number>(DEFAULT_BUDGET);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<UserDetailResponse>(`/api/admin/users/${userId}`, { noOrg: true });
      const v = res.settings?.daily_ai_budget_usd ?? DEFAULT_BUDGET;
      setBudget(v);
      setOriginal(v);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/admin/users/${userId}/budget`, {
        method: "PATCH",
        body: { daily_ai_budget_usd: budget },
        noOrg: true,
      });
      setOriginal(budget);
      toast.success(t("saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const dirty = budget !== original;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground" dir="auto">
          {t("description")}
        </p>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium" dir="auto">{t("label")}</label>
            {loading ? (
              <div className="h-9 w-[140px] rounded-md border bg-muted/40 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                value={budget}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setBudget(n);
                }}
                className="w-[140px]"
              />
            )}
          </div>
          <Button onClick={save} disabled={saving || loading || !dirty} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
