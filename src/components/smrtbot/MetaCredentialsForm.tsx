"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, PlugZap } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

const FIELDS = [
  "live_wa_phone_number_id", "live_wa_access_token", "live_verify_token", "live_phone_display",
  "test_wa_phone_number_id", "test_wa_access_token", "test_verify_token", "test_phone_display",
] as const;
type Field = (typeof FIELDS)[number];

// Where each value is found in Meta. The hint text is translated; the link text
// is the translated "directLink" word, which becomes the clickable anchor.
const META_APPS = "https://developers.facebook.com/apps";
const META_SYSTEM_USERS = "https://business.facebook.com/settings/system-users";
const META_WEBHOOKS_DOCS = "https://developers.facebook.com/docs/graph-api/webhooks/getting-started";
const LINKS: Partial<Record<Field, string>> = {
  live_wa_phone_number_id: META_APPS,
  live_wa_access_token: META_SYSTEM_USERS,
  live_verify_token: META_WEBHOOKS_DOCS,
  test_wa_phone_number_id: META_APPS,
  test_wa_access_token: META_SYSTEM_USERS,
  test_verify_token: META_WEBHOOKS_DOCS,
};
// Hints reuse one key per logical field (live/test share the same guidance).
const HINT_KEY: Partial<Record<Field, string>> = {
  live_wa_phone_number_id: "hint_phone_number_id",
  live_wa_access_token: "hint_access_token",
  live_verify_token: "hint_verify_token",
  live_phone_display: "hint_phone_display",
  test_wa_phone_number_id: "hint_phone_number_id",
  test_wa_access_token: "hint_access_token",
  test_verify_token: "hint_verify_token",
  test_phone_display: "hint_phone_display",
};

/** Official (Meta Cloud API) WhatsApp credentials — live + test environments.
 *  Shown in the WhatsApp tab when the bot is on the `meta` transport. */
export function MetaCredentialsForm({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [form, setForm] = useState<Record<string, string>>({});
  const [slug, setSlug] = useState<string>("");
  const [orgSlug, setOrgSlug] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // App Secrets are write-only (stored in Vault): we only learn whether each is
  // set, never the value. Inputs hold a new value to save.
  const [hasSecret, setHasSecret] = useState<{ live: boolean; test: boolean }>({ live: false, test: false });
  const [secretInput, setSecretInput] = useState<{ live: string; test: string }>({ live: "", test: "" });
  const [savingSecret, setSavingSecret] = useState<"live" | "test" | null>(null);

  const load = useCallback(async () => {
    const { bot } = await api<{ bot: Record<string, string | null> }>(`/api/bot/bots/${botId}`);
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f] = (bot[f] as string | null) ?? "";
    setForm(next);
    setSlug((bot.slug as string | null) ?? "");
    setOrgSlug((bot.org_slug as string | null) ?? "");
    setHasSecret({ live: !!bot.live_app_secret_id, test: !!bot.test_app_secret_id });
    setSecretInput({ live: "", test: "" });
    setLoaded(true);
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveAppSecret(env: "live" | "test") {
    const value = secretInput[env].trim();
    if (!value) return;
    setSavingSecret(env);
    try {
      await api(`/api/bot/bots/${botId}/app-secret`, { method: "PUT", body: { env, value } });
      toast.success(t("updated"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingSecret(null);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/api/bot/bots/${botId}`, { method: "PATCH", body: form });
      toast.success(t("updated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error("clipboard");
    }
  }

  // Same handshake Meta performs: GET the public callback with the verify token
  // and a random challenge; a correct webhook echoes the challenge verbatim.
  // Tests the SAVED config (the webhook reads the token from the DB), so save
  // first. Same-origin fetch, no backend needed.
  async function testConnection() {
    const token = (form.live_verify_token || form.test_verify_token || "").trim();
    if (!callbackUrl) return;
    if (!token) {
      toast.error(t("testNoToken"));
      return;
    }
    setTesting(true);
    try {
      const nonce = `smrtesy-${Math.random().toString(36).slice(2)}`;
      const u = `${callbackUrl}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${encodeURIComponent(nonce)}`;
      const res = await fetch(u);
      const body = (await res.text()).trim();
      if (res.ok && body === nonce) toast.success(t("testOk"));
      else toast.error(t("testFail"));
    } catch {
      toast.error(t("testFail"));
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">…</p>;

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const ref = orgSlug && slug ? `${orgSlug}_${slug}` : slug;
  const callbackUrl = ref ? `${origin}/api/webhooks/smrtbot/${ref}` : "";

  const hint = (f: Field) => {
    const key = HINT_KEY[f];
    if (!key) return null;
    const url = LINKS[f];
    return (
      <p className="text-xs text-muted-foreground">
        {t(key)}{" "}
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
            {t("directLink")}
          </a>
        ) : null}
      </p>
    );
  };

  const field = (f: Field) => (
    <div className="space-y-1">
      <label className="text-sm font-medium">{t(`f_${f}`)}</label>
      <Input dir="ltr" value={form[f] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f]: e.target.value }))} />
      {hint(f)}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Callback URL — the value the user pastes into Meta's webhook config */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("callbackTitle")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("callbackHint")}{" "}
            <a href={META_WEBHOOKS_DOCS} target="_blank" rel="noreferrer" className="text-primary underline">
              {t("directLink")}
            </a>
          </p>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("callbackUrlLabel")}</label>
            <div className="flex items-center gap-2">
              <Input dir="ltr" readOnly value={callbackUrl} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="icon" onClick={() => copy(callbackUrl)} disabled={!callbackUrl}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("callbackVerifyNote")}</p>
          <div className="flex items-center gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={testConnection} disabled={testing || !callbackUrl}>
              <PlugZap className="me-2 h-4 w-4" />
              {testing ? "…" : t("testConnection")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("testHint")}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("appSecretTitle")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("appSecretVaultHint")}{" "}
            <a href={META_APPS} target="_blank" rel="noreferrer" className="text-primary underline">{t("directLink")}</a>
          </p>
          {(["live", "test"] as const).map((env) => (
            <div key={env} className="space-y-1">
              <label className="text-sm font-medium">
                {env === "live" ? t("appSecretLive") : t("appSecretTest")}{" "}
                <span className={hasSecret[env] ? "text-green-600" : "text-muted-foreground"}>
                  {hasSecret[env] ? `· ${t("appSecretSet")}` : `· ${t("appSecretUnset")}`}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Input
                  dir="ltr"
                  type="password"
                  className="flex-1"
                  placeholder={hasSecret[env] ? "•••••••• (" + t("appSecretReplace") + ")" : ""}
                  value={secretInput[env]}
                  onChange={(e) => setSecretInput((p) => ({ ...p, [env]: e.target.value }))}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={savingSecret === env || !secretInput[env].trim()}
                  onClick={() => saveAppSecret(env)}
                >
                  {savingSecret === env ? "…" : t("save")}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("tabLive")}</h2>
          {field("live_wa_phone_number_id")}
          {field("live_wa_access_token")}
          {field("live_verify_token")}
          {field("live_phone_display")}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("tabTest")}</h2>
          {field("test_wa_phone_number_id")}
          {field("test_wa_access_token")}
          {field("test_verify_token")}
          {field("test_phone_display")}
        </CardContent>
      </Card>
      <Button onClick={save} disabled={saving}>
        {saving ? "…" : t("save")}
      </Button>
    </div>
  );
}
