"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

interface Bot {
  id: string;
  name: string;
  web_enabled: boolean | null;
  web_accent_color: string | null;
  web_allowed_origins: string[] | null;
  web_greeting: string | null;
  web_key: string | null;
}

/** Web-chat channel settings + the embeddable snippet for a bot. */
export function WebChatSettings({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [bot, setBot] = useState<Bot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable draft.
  const [enabled, setEnabled] = useState(false);
  const [accent, setAccent] = useState("#2563eb");
  const [origins, setOrigins] = useState("");
  const [greeting, setGreeting] = useState("");

  const hydrate = useCallback((b: Bot) => {
    setBot(b);
    setEnabled(!!b.web_enabled);
    setAccent(b.web_accent_color || "#2563eb");
    setOrigins((b.web_allowed_origins ?? []).join("\n"));
    setGreeting(b.web_greeting ?? "");
  }, []);

  const load = useCallback(async () => {
    try {
      const { bot } = await api<{ bot: Bot }>(`/api/bot/bots/${botId}`);
      hydrate(bot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId, hydrate]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const { bot } = await api<{ bot: Bot }>(`/api/bot/bots/${botId}`, {
        method: "PATCH",
        body: {
          web_enabled: enabled,
          web_accent_color: accent,
          web_allowed_origins: origins
            .split("\n")
            .map((o) => o.trim())
            .filter(Boolean),
          web_greeting: greeting.trim() || null,
        },
      });
      hydrate(bot);
      toast.success(t("updated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    if (!window.confirm(t("webRegenerateConfirm"))) return;
    try {
      const { web_key } = await api<{ web_key: string }>(`/api/bot/bots/${botId}/web-key`, { method: "POST" });
      setBot((b) => (b ? { ...b, web_key } : b));
      toast.success(t("updated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const snippet = useMemo(() => {
    if (!bot?.web_key) return "";
    return `<script src="${origin}/smrtbot-widget.js"\n        data-key="${bot.web_key}"\n        data-accent="${accent}"\n        data-lang="he"\n        async></script>`;
  }, [bot?.web_key, origin, accent]);

  function copySnippet() {
    if (!snippet) return;
    void navigator.clipboard.writeText(snippet);
    toast.success(t("webCopied"));
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!bot) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("webIntro")}</p>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium">{t("webEnable")}</span>
              <span className="block text-xs text-muted-foreground">{t("webEnableHint")}</span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">{t("webAccent")}</label>
            <input
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent"
            />
            <Input dir="ltr" value={accent} onChange={(e) => setAccent(e.target.value)} className="w-32" />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("webGreeting")}</label>
            <Input dir="auto" value={greeting} onChange={(e) => setGreeting(e.target.value)} />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("webOrigins")}</label>
            <textarea
              dir="ltr"
              rows={3}
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
            <p className="text-xs text-muted-foreground">{t("webOriginsHint")}</p>
          </div>

          <Button onClick={save} disabled={saving}>
            {t("save")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">{t("webEmbedTitle")}</label>
            {bot.web_key && (
              <Button variant="ghost" size="sm" onClick={regenerate}>
                <RefreshCw className="me-1 h-3.5 w-3.5" />
                {t("webRegenerate")}
              </Button>
            )}
          </div>
          {bot.web_enabled && bot.web_key ? (
            <>
              <p className="text-xs text-muted-foreground">{t("webEmbedHint")}</p>
              <pre dir="ltr" className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                {snippet}
              </pre>
              <Button variant="outline" size="sm" onClick={copySnippet}>
                <Copy className="me-1 h-3.5 w-3.5" />
                {t("webCopy")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("webNotEnabled")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
