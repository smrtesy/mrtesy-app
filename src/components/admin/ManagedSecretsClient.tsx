"use client";

// Managed secrets — the live-mirror super-admin screen (phase 1: Railway).
// Design: docs/managed-secrets-plan.md. Every write goes through the confirm
// dialog (the plan's mandatory human-approval step) → POST .../sync {confirm:true}.
// The screen never shows a secret VALUE — only presence, a fingerprint, and drift.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

interface Target {
  id: string;
  provider: string;
  target_ref: string | null;
  env_var_name: string;
  environment: string;
  configured: boolean;
  present: boolean | null;
  matches: boolean | null;
  hint?: string;
  provider_error?: string;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
}

interface Secret {
  id: string;
  key_name: string;
  description: string | null;
  has_value: boolean;
  fingerprint: string | null;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
  drift: boolean;
  targets: Target[];
}

interface LogRow {
  id: string;
  action: string;
  provider: string | null;
  env_var_name: string | null;
  result: string;
  message: string | null;
  actor: string | null;
  created_at: string;
}

const NY_TZ = "America/New_York";
function fmtNY(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: NY_TZ,
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function ManagedSecretsClient() {
  const t = useTranslations("adminSecretsManaged");

  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ secrets: Secret[] }>(`/api/admin/secrets`);
      setSecrets(res.secrets);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {t("addSecret")}
          </Button>
        </div>
      </div>

      {adding && (
        <AddSecretForm
          onDone={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      )}

      {!loading && secrets.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("noSecrets")}</p>
      )}

      <div className="space-y-4">
        {secrets.map((s) => (
          <SecretCard key={s.id} secret={s} onChange={load} />
        ))}
      </div>
    </div>
  );
}

function AddSecretForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations("adminSecretsManaged");
  const [keyName, setKeyName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!keyName.trim()) return;
    setBusy(true);
    try {
      await api(`/api/admin/secrets`, {
        method: "POST",
        body: {
          key_name: keyName.trim(),
          description: description.trim() || undefined,
          value: value || undefined,
        },
      });
      toast.success(t("created"));
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("addSecret")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("keyName")}</label>
          <Input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder={t("keyNamePlaceholder")}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("descriptionLabel")}</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("valueOptional")}</label>
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("valuePlaceholder")}
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">{t("valueHint")}</p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={submit} disabled={busy || !keyName.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("create")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SecretCard({ secret, onChange }: { secret: Secret; onChange: () => void }) {
  const t = useTranslations("adminSecretsManaged");
  const [rotating, setRotating] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [addingTarget, setAddingTarget] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);

  async function rotate() {
    if (!newValue) return;
    setBusy(true);
    try {
      await api(`/api/admin/secrets/${secret.id}`, { method: "PUT", body: { value: newValue } });
      toast.success(t("valueSaved"));
      setNewValue("");
      setRotating(false);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeTarget(targetId: string) {
    try {
      await api(`/api/admin/secrets/${secret.id}/targets/${targetId}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      const res = await api<{ results: Array<{ ok: boolean; env_var_name: string; error?: string }> }>(
        `/api/admin/secrets/${secret.id}/sync`,
        { method: "POST", body: { confirm: true } },
      );
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length === 0) toast.success(t("syncAllOk"));
      else toast.error(t("syncSomeFailed", { n: failed.length }));
      setConfirmSync(false);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function deleteSecret() {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    try {
      await api(`/api/admin/secrets/${secret.id}`, { method: "DELETE" });
      toast.success(t("deleted"));
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              {secret.key_name}
              {secret.has_value ? (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {t("fp")}: {secret.fingerprint}
                </Badge>
              ) : (
                <Badge variant="outline">{t("noValue")}</Badge>
              )}
              {secret.drift ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {t("drift")}
                </Badge>
              ) : secret.has_value && secret.targets.length > 0 ? (
                <Badge variant="secondary" className="gap-1">
                  <Check className="h-3 w-3" />
                  {t("inSync")}
                </Badge>
              ) : null}
            </CardTitle>
            {secret.description && (
              <p className="text-xs text-muted-foreground">{secret.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmSync(true)}
              disabled={!secret.has_value || secret.targets.length === 0}
              title={t("syncNow")}
            >
              <RefreshCw className="h-4 w-4" />
              {t("syncNow")}
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setShowLog((v) => !v)} title={t("log")}>
              <ScrollText className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={deleteSecret} disabled={busy} title={t("delete")}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Value row */}
        <div className="flex items-center gap-2">
          {!rotating ? (
            <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
              <KeyRound className="h-4 w-4" />
              {secret.has_value ? t("rotateValue") : t("setValue")}
            </Button>
          ) : (
            <div className="flex items-center gap-2 w-full">
              <Input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={t("valuePlaceholder")}
                autoComplete="new-password"
                className="max-w-md"
              />
              <Button size="sm" onClick={rotate} disabled={busy || !newValue}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRotating(false);
                  setNewValue("");
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          )}
          {secret.rotated_at && (
            <span className="text-xs text-muted-foreground">
              {t("rotatedAt")}: {fmtNY(secret.rotated_at)}
            </span>
          )}
        </div>

        {/* Targets */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t("targets")}</span>
            <Button size="sm" variant="ghost" onClick={() => setAddingTarget((v) => !v)}>
              <Plus className="h-3.5 w-3.5" />
              {t("addTarget")}
            </Button>
          </div>

          {secret.targets.length === 0 && !addingTarget && (
            <p className="text-xs text-muted-foreground">{t("noTargets")}</p>
          )}

          {secret.targets.map((tg) => (
            <TargetRow key={tg.id} target={tg} onRemove={() => removeTarget(tg.id)} />
          ))}

          {addingTarget && (
            <AddTargetForm
              secretId={secret.id}
              onDone={() => {
                setAddingTarget(false);
                onChange();
              }}
              onCancel={() => setAddingTarget(false)}
            />
          )}
        </div>

        {showLog && <SecretLog secretId={secret.id} />}
      </CardContent>

      {/* Approval dialog — the plan's mandatory confirm-before-write step. */}
      <Dialog open={confirmSync} onOpenChange={setConfirmSync}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("syncConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("syncConfirmBody", { key: secret.key_name })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm">
            {secret.targets.map((tg) => (
              <div key={tg.id} className="flex items-center gap-2 font-mono text-xs">
                <Badge variant="outline">{tg.provider}</Badge>
                <span>{tg.env_var_name}</span>
                <span className="text-muted-foreground">· {tg.environment}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmSync(false)} disabled={syncing}>
              {t("cancel")}
            </Button>
            <Button onClick={runSync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t("confirmSync")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TargetRow({ target, onRemove }: { target: Target; onRemove: () => void }) {
  const t = useTranslations("adminSecretsManaged");

  let status: { label: string; variant: "secondary" | "destructive" | "outline"; icon: React.ReactNode };
  if (!target.configured || target.provider_error) {
    status = {
      label: target.provider_error ? t("providerError") : t("notConfigured"),
      variant: "outline",
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  } else if (target.present === false) {
    status = { label: t("missing"), variant: "destructive", icon: <X className="h-3 w-3" /> };
  } else if (target.matches === false) {
    status = { label: t("differs"), variant: "destructive", icon: <AlertTriangle className="h-3 w-3" /> };
  } else if (target.matches === true) {
    status = { label: t("present"), variant: "secondary", icon: <Check className="h-3 w-3" /> };
  } else {
    status = { label: t("presentUnknown"), variant: "outline", icon: <Check className="h-3 w-3" /> };
  }

  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm flex-wrap">
      <Badge variant="outline" className="uppercase">{target.provider}</Badge>
      <span className="font-mono text-xs">{target.env_var_name}</span>
      <span className="text-xs text-muted-foreground">· {target.environment}</span>
      {target.target_ref && (
        <span className="text-[10px] text-muted-foreground font-mono">({target.target_ref})</span>
      )}
      <Badge variant={status.variant} className="gap-1 ml-auto">
        {status.icon}
        {status.label}
      </Badge>
      {target.last_sync_status && (
        <span className="text-[10px] text-muted-foreground">
          {t("lastSync")}: {target.last_sync_status === "ok" ? t("ok") : t("error")}
        </span>
      )}
      <Button size="icon" variant="ghost" onClick={onRemove} title={t("removeTarget")}>
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
      {(target.provider_error || target.hint) && (
        <p className="w-full text-[11px] text-muted-foreground">{target.provider_error || target.hint}</p>
      )}
    </div>
  );
}

function AddTargetForm({
  secretId,
  onDone,
  onCancel,
}: {
  secretId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("adminSecretsManaged");
  const [provider, setProvider] = useState("railway");
  const [envVar, setEnvVar] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [targetRef, setTargetRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!envVar.trim()) return;
    setBusy(true);
    try {
      await api(`/api/admin/secrets/${secretId}/targets`, {
        method: "POST",
        body: {
          provider,
          env_var_name: envVar.trim().toUpperCase(),
          environment: environment.trim() || "production",
          target_ref: targetRef.trim() || undefined,
        },
      });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-dashed p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("provider")}</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="railway">Railway</SelectItem>
              <SelectItem value="vercel">Vercel ({t("soon")})</SelectItem>
              <SelectItem value="supabase">Supabase ({t("soon")})</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("envVarName")}</label>
          <Input value={envVar} onChange={(e) => setEnvVar(e.target.value)} placeholder="WHATSAPP_OUTBOUND_KEY" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("environment")}</label>
          <Input value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="production" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t("targetRef")}</label>
          <Input value={targetRef} onChange={(e) => setTargetRef(e.target.value)} placeholder={t("targetRefPlaceholder")} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={busy || !envVar.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t("add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

function SecretLog({ secretId }: { secretId: string }) {
  const t = useTranslations("adminSecretsManaged");
  const [log, setLog] = useState<LogRow[] | null>(null);

  useEffect(() => {
    api<{ log: LogRow[] }>(`/api/admin/secrets/${secretId}/log`)
      .then((r) => setLog(r.log))
      .catch(() => setLog([]));
  }, [secretId]);

  if (log === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("loading")}
      </div>
    );
  }
  if (log.length === 0) return <p className="text-xs text-muted-foreground">{t("logEmpty")}</p>;

  return (
    <div className="rounded-md border divide-y text-xs">
      {log.map((row) => (
        <div key={row.id} className="flex items-center gap-2 px-3 py-1.5">
          <Badge variant={row.result === "ok" ? "secondary" : "destructive"} className="text-[10px]">
            {row.action}
          </Badge>
          {row.provider && <span className="uppercase text-muted-foreground">{row.provider}</span>}
          {row.env_var_name && <span className="font-mono">{row.env_var_name}</span>}
          {row.message && <span className="text-muted-foreground truncate">{row.message}</span>}
          <span className="ml-auto text-muted-foreground shrink-0">{fmtNY(row.created_at)}</span>
          {row.actor && <span className="text-muted-foreground shrink-0">· {row.actor}</span>}
        </div>
      ))}
    </div>
  );
}
