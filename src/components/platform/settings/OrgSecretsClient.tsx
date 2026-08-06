"use client";

/**
 * OrgSecretsClient — the active org's own secrets (security plan §5.4).
 *
 * An org's OWNER manages the credentials the org brings itself (its own
 * WhatsApp/OpenAI/SMTP/Stripe keys, …). These are NOT the platform-wide keys
 * (those stay super-admin-only). The value is stored encrypted in Vault and is
 * never returned here — the list shows only "set" + a last-4 hint. Owner-only,
 * scoped to the active org by the backend; a developer is excluded entirely.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, Plus, Trash2, Loader2, Lock, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface OrgSecret {
  key: string;
  is_secret: boolean;
  is_set: boolean;
  last4: string | null;
  value_text: string | null;
  notes: string | null;
  updated_at: string;
}

export function OrgSecretsClient() {
  const t = useTranslations("orgSecrets");
  const [secrets, setSecrets] = useState<OrgSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add form
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newIsSecret, setNewIsSecret] = useState(true);
  const [newNotes, setNewNotes] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { secrets } = await api<{ secrets: OrgSecret[] }>("/api/org/secrets");
      setSecrets(secrets ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("smrtesy:active-org-changed", handler);
    return () => window.removeEventListener("smrtesy:active-org-changed", handler);
  }, [refresh]);

  async function handleSave() {
    if (!newKey.trim() || !newValue) return;
    setSaving(true);
    try {
      await api("/api/org/secrets", {
        method: "POST",
        body: { key: newKey.trim(), value: newValue, is_secret: newIsSecret, notes: newNotes.trim() || null },
      });
      toast.success(t("saved"));
      setNewKey(""); setNewValue(""); setNewNotes(""); setNewIsSecret(true);
      setAdding(false);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(key: string) {
    if (!window.confirm(t("deleteConfirm", { key }))) return;
    try {
      await api(`/api/org/secrets/${encodeURIComponent(key)}`, { method: "DELETE" });
      toast.success(t("deleted"));
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          {t("title")}
        </CardTitle>
        {/* Compact-UI: quiet add entry point that expands on demand. */}
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setAdding((v) => !v)}>
          {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {adding ? t("cancel") : t("add")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("intro")}</p>

        {adding && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder={t("keyPlaceholder")}
              dir="ltr"
              className="font-mono text-sm"
            />
            <Input
              type={newIsSecret ? "password" : "text"}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={t("valuePlaceholder")}
              dir="ltr"
              className="font-mono text-sm"
            />
            <Input
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              dir="auto"
              className="text-sm"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={newIsSecret} onChange={(e) => setNewIsSecret(e.target.checked)} />
                {t("isSecretLabel")}
              </label>
              <Button size="sm" className="h-8 gap-1" disabled={saving || !newKey.trim() || !newValue} onClick={handleSave}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {t("save")}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">{t("empty")}</p>
        ) : (
          <div className="space-y-1.5">
            {secrets.map((s) => (
              <div key={s.key} className="flex items-center gap-2 rounded-lg border p-2.5 min-w-0">
                <div className="shrink-0 rounded-full bg-muted p-1.5">
                  {s.is_secret ? <Lock className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <code className="text-sm font-mono font-medium truncate">{s.key}</code>
                    {!s.is_secret && (
                      <Badge variant="secondary" className="shrink-0 text-[9px]">{t("configBadge")}</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {s.is_secret
                      ? (s.is_set ? `••••${s.last4 ?? ""}` : t("notSet"))
                      : (s.value_text ?? "")}
                    {s.notes ? ` · ${s.notes}` : ""}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0 h-8 w-8 text-destructive hover:bg-destructive/10"
                  title={t("delete")}
                  onClick={() => handleDelete(s.key)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
