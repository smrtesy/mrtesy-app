"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CircleUser, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

/** One account as GET /api/admin/claude-accounts reports it. */
interface AdminAccount {
  id: string;
  label: string | null;
  configured: boolean;
  removable: boolean;
}

/**
 * Claude accounts — the one place to manage every subscription account the in-app
 * Claude console can run on. Consolidates the scattered CLAUDE_CODE_OAUTH_TOKEN_<ID>
 * / CLAUDE_ACCOUNT_LABEL_<ID> / CLAUDE_ACCOUNTS secrets into a list + a single
 * "add account" form (id + label + token). Rendered only on the platform app's
 * secrets screen (super-admin), where the tokens already live.
 */
export function ClaudeAccountsPanel() {
  const t = useTranslations("claudeAccounts");
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { accounts: list } = await api<{ accounts: AdminAccount[] }>("/api/admin/claude-accounts");
      setAccounts(list ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    if (!window.confirm(t("removeConfirm", { id }))) return;
    try {
      await api(`/api/admin/claude-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success(t("removed"));
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CircleUser className="h-4 w-4 text-muted-foreground" />
              {t("title")}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t("hint")}</p>
          </div>
          {/* Collapsed behind one icon (CLAUDE.md compact convention). */}
          <Button
            size="sm"
            variant={adding ? "secondary" : "outline"}
            className="h-7 shrink-0"
            onClick={() => {
              setAdding((v) => !v);
              setEditingId(null);
            }}
            aria-label={t("addAccount")}
            title={t("addAccount")}
          >
            {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && (
          <AccountForm
            mode="add"
            onDone={() => {
              setAdding(false);
              void load();
            }}
          />
        )}

        {accounts === null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("loading")}
          </div>
        )}

        {accounts?.map((a) => (
          <div key={a.id} className="rounded border p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
                {a.label?.trim() || a.id}
              </span>
              <code className="shrink-0 text-[11px] text-muted-foreground" dir="ltr">
                {a.id}
              </code>
              {a.configured ? (
                <Badge variant="secondary" className="shrink-0">
                  {t("configured")}
                </Badge>
              ) : (
                <Badge variant="outline" className="shrink-0 text-muted-foreground">
                  {t("notConfigured")}
                </Badge>
              )}
              {!a.removable && (
                <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                  {t("builtin")}
                </Badge>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => {
                  setEditingId((cur) => (cur === a.id ? null : a.id));
                  setAdding(false);
                }}
                aria-label={t("edit")}
                title={t("edit")}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {a.removable && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-destructive"
                  onClick={() => void remove(a.id)}
                  aria-label={t("remove")}
                  title={t("remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {editingId === a.id && (
              <div className="mt-2">
                <AccountForm
                  mode="edit"
                  account={a}
                  onDone={() => {
                    setEditingId(null);
                    void load();
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * The add/edit form. In `add` mode all three fields show and id + token are
 * required; in `edit` mode the id is fixed and both label and token are optional
 * (leave token blank to keep the current one, fill it to rotate).
 */
function AccountForm({
  mode,
  account,
  onDone,
}: {
  mode: "add" | "edit";
  account?: AdminAccount;
  onDone: () => void;
}) {
  const t = useTranslations("claudeAccounts");
  const [id, setId] = useState(account?.id ?? "");
  const [label, setLabel] = useState(account?.label ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  // Mirrors the server's ACCOUNT_ID_RE so a bad id is caught before the round trip.
  const cleanId = id.trim().toLowerCase();
  const idValid = /^[a-z0-9_]{1,32}$/.test(cleanId);
  const canSave = mode === "edit" ? true : idValid && token.trim().length > 0;

  async function save() {
    setSaving(true);
    try {
      await api("/api/admin/claude-accounts", {
        method: "POST",
        body: {
          id: mode === "edit" ? account!.id : cleanId,
          label: label.trim() || undefined,
          token: token.trim() || undefined,
        },
      });
      toast.success(t("saved"));
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-dashed p-2">
      {mode === "add" && (
        <div>
          <Input
            value={cleanId}
            onChange={(e) => setId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder={t("idPlaceholder")}
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t("idHint")}</p>
        </div>
      )}
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        dir="auto"
        className="text-xs"
        placeholder={t("labelPlaceholder")}
        autoComplete="off"
      />
      <div>
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          dir="ltr"
          className="font-mono text-xs"
          placeholder={mode === "edit" ? t("tokenPlaceholderKeep") : t("tokenPlaceholder")}
          autoComplete="off"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">{t("tokenHint")}</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-7" onClick={onDone} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button size="sm" className="h-7" onClick={() => void save()} disabled={!canSave || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("save")}
        </Button>
      </div>
    </div>
  );
}
