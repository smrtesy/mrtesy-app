"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Check, Copy, Edit2, Eye, EyeOff, Loader2, Webhook, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

interface PlatformSecret {
  key: string;
  is_secret: boolean;
  value_text: string | null;
  is_set: boolean;
}

interface WhatsAppConnection {
  id: string;
  user_id: string;
  phone_number_id: string;
  waba_id: string | null;
  business_id: string | null;
  display_phone_number: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  access_token_set: boolean;
  app_secret_set: boolean;
  verify_token_set: boolean;
}

interface SecretsResponse {
  platform: PlatformSecret[];
  connections: WhatsAppConnection[];
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
const WEBHOOK_URL = `${BACKEND_URL}/api/webhooks/whatsapp`;

export default function AdminAppSecretsPage() {
  const t = useTranslations("adminSecrets");
  const { locale, slug } = useParams<{ locale: string; slug: string }>();

  const [data, setData] = useState<SecretsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  function copyWebhook() {
    navigator.clipboard.writeText(WEBHOOK_URL).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error("Clipboard error"),
    );
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<SecretsResponse>(`/api/admin/apps/${slug}/secrets`);
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          {slug}
        </Link>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      )}

      {!loading && data && (
        <>
          {/* Webhook URL — the value the operator pastes into DualHook's
              Webhook Override field. Read-only, copyable. Shown here as
              well as in /onboarding/whatsapp so a super-admin debugging a
              tenant doesn't have to leave the admin surface. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                {t("webhookUrlSection")}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{t("webhookUrlHint")}</p>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input value={WEBHOOK_URL} readOnly dir="ltr" className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyWebhook}
                  aria-label={t("copy")}
                >
                  {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <PlatformSection slug={slug} platform={data.platform} onSaved={load} />
          <ConnectionsSection slug={slug} connections={data.connections} onSaved={load} />
        </>
      )}
    </div>
  );
}

function PlatformSection({
  slug,
  platform,
  onSaved,
}: {
  slug: string;
  platform: PlatformSecret[];
  onSaved: () => void;
}) {
  const t = useTranslations("adminSecrets");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("platformSection")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("platformHint")}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {platform.map((p) => (
          <PlatformRow key={p.key} slug={slug} secret={p} onSaved={onSaved} />
        ))}
      </CardContent>
    </Card>
  );
}

function PlatformRow({
  slug,
  secret,
  onSaved,
}: {
  slug: string;
  secret: PlatformSecret;
  onSaved: () => void;
}) {
  const t = useTranslations("adminSecrets");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(secret.is_secret ? "" : secret.value_text ?? "");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/admin/apps/${slug}/secrets/${encodeURIComponent(secret.key)}`, {
        method: "PUT",
        body: { value },
      });
      toast.success(t("saved"));
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setValue(secret.is_secret ? "" : secret.value_text ?? "");
  }

  return (
    <div className="flex items-start gap-2 rounded border p-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono">{secret.key}</code>
          {secret.is_secret && (
            <Badge variant="outline" className="text-[10px]">
              {t("encrypted")}
            </Badge>
          )}
          {secret.is_set ? (
            <Badge variant="default" className="text-[10px] bg-green-500/80">
              {t("isSet")}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
              {t("notSet")}
            </Badge>
          )}
        </div>

        {!editing && !secret.is_secret && (
          <p className="mt-1 text-xs text-muted-foreground font-mono break-all">
            {secret.value_text ?? "—"}
          </p>
        )}

        {editing && (
          <div className="mt-2 flex gap-1">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={secret.is_secret && !show ? "password" : "text"}
              dir="ltr"
              className="font-mono text-xs"
              placeholder={secret.is_secret ? "••••••••••••" : t("plainValuePlaceholder")}
              autoComplete="off"
            />
            {secret.is_secret && (
              <Button type="button" variant="outline" size="icon" onClick={() => setShow((v) => !v)}>
                {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {!editing ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="h-7">
            <Edit2 className="h-3 w-3 me-1" />
            {t("edit")}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={save} disabled={saving || !value} className="h-7">
              {saving ? (
                <Loader2 className="h-3 w-3 me-1 animate-spin" />
              ) : (
                <Check className="h-3 w-3 me-1" />
              )}
              {t("save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel} className="h-7">
              <X className="h-3 w-3 me-1" />
              {t("cancel")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ConnectionsSection({
  slug,
  connections,
  onSaved,
}: {
  slug: string;
  connections: WhatsAppConnection[];
  onSaved: () => void;
}) {
  const t = useTranslations("adminSecrets");

  if (connections.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("connectionsSection")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("noConnections")}</p>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("connectionsSection")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("connectionsHint")}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {connections.map((c) => (
          <ConnectionRow key={c.id} slug={slug} connection={c} onSaved={onSaved} />
        ))}
      </CardContent>
    </Card>
  );
}

function ConnectionRow({
  slug,
  connection,
  onSaved,
}: {
  slug: string;
  connection: WhatsAppConnection;
  onSaved: () => void;
}) {
  const t = useTranslations("adminSecrets");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function save() {
    const body: Record<string, string> = {};
    if (accessToken.trim()) body.access_token = accessToken.trim();
    if (appSecret.trim()) body.app_secret = appSecret.trim();
    if (verifyToken.trim()) body.verify_token = verifyToken.trim();
    if (Object.keys(body).length === 0) {
      toast.error(t("nothingToSave"));
      return;
    }

    setSaving(true);
    try {
      await api(
        `/api/admin/apps/${slug}/connections/${encodeURIComponent(connection.phone_number_id)}/secrets`,
        { method: "PUT", body },
      );
      toast.success(t("saved"));
      setAccessToken("");
      setAppSecret("");
      setVerifyToken("");
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border p-2 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {connection.display_phone_number || connection.phone_number_id}
          </p>
          <p className="text-xs text-muted-foreground font-mono break-all">
            phone_number_id: {connection.phone_number_id}
            {connection.waba_id ? ` · waba_id: ${connection.waba_id}` : ""}
            {connection.business_id ? ` · business_id: ${connection.business_id}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <SecretChip label="access_token" set={connection.access_token_set} />
            <SecretChip label="app_secret" set={connection.app_secret_set} />
            <SecretChip label="verify_token" set={connection.verify_token_set} />
            {connection.disconnected_at && (
              <Badge variant="destructive" className="text-[10px]">
                {t("disconnected")}
              </Badge>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} className="h-7">
          <Edit2 className="h-3 w-3 me-1" />
          {open ? t("close") : t("rotate")}
        </Button>
      </div>

      {open && (
        <div className="space-y-2 pt-2 border-t">
          <p className="text-xs text-muted-foreground">{t("rotateHint")}</p>
          <SecretField
            label={t("accessToken")}
            value={accessToken}
            onChange={setAccessToken}
            placeholder="EAAxxxxxxxxx..."
          />
          <SecretField
            label={t("appSecret")}
            value={appSecret}
            onChange={setAppSecret}
            placeholder="••••••••••••••••"
          />
          <SecretField
            label={t("verifyToken")}
            value={verifyToken}
            onChange={setVerifyToken}
            placeholder="random-string-you-chose"
          />
          <Button size="sm" onClick={save} disabled={saving} className="w-full">
            {saving ? <Loader2 className="h-3 w-3 me-1 animate-spin" /> : <Check className="h-3 w-3 me-1" />}
            {t("rotateSelected")}
          </Button>
        </div>
      )}
    </div>
  );
}

function SecretChip({ label, set }: { label: string; set: boolean }) {
  const t = useTranslations("adminSecrets");
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${
        set
          ? "border-green-300 text-green-700"
          : "border-amber-300 text-amber-600"
      }`}
    >
      {label}: {set ? t("isSet") : t("notSet")}
    </Badge>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      <div className="flex gap-1">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
          className="font-mono text-xs"
          placeholder={placeholder}
          autoComplete="off"
        />
        <Button type="button" variant="outline" size="icon" onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
