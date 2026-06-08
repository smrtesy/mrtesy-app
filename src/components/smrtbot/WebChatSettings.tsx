"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, RefreshCw, Upload, X } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

const ICON_BUCKET = "smrtbot-web-icons";
const ICON_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — must match the bucket limit
const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

interface Bot {
  id: string;
  org_id: string;
  name: string;
  web_enabled: boolean | null;
  web_accent_color: string | null;
  web_allowed_origins: string[] | null;
  web_greeting: string | null;
  web_icon_url: string | null;
  web_title: string | null;
  web_subtitle: string | null;
  web_position: string | null;
  web_size: string | null;
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
  const [iconUrl, setIconUrl] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [position, setPosition] = useState("right");
  const [size, setSize] = useState("standard");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hydrate = useCallback((b: Bot) => {
    setBot(b);
    setEnabled(!!b.web_enabled);
    setAccent(b.web_accent_color || "#2563eb");
    setOrigins((b.web_allowed_origins ?? []).join("\n"));
    setGreeting(b.web_greeting ?? "");
    setIconUrl(b.web_icon_url ?? "");
    setTitle(b.web_title ?? "");
    setSubtitle(b.web_subtitle ?? "");
    setPosition(b.web_position || "right");
    setSize(b.web_size || "standard");
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
          web_icon_url: iconUrl.trim() || null,
          web_title: title.trim() || null,
          web_subtitle: subtitle.trim() || null,
          web_position: position,
          web_size: size,
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

  async function onPickIcon(file: File | null) {
    if (!file || !bot) return;
    if (!ICON_TYPES.includes(file.type)) {
      toast.error(t("webIconBadType"));
      return;
    }
    if (file.size > ICON_MAX_BYTES) {
      toast.error(t("webIconTooLarge"));
      return;
    }
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${bot.org_id}/${bot.id}/icon-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(ICON_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        toast.error(upErr.message);
        return;
      }
      const { data } = supabase.storage.from(ICON_BUCKET).getPublicUrl(path);
      setIconUrl(data.publicUrl);
      toast.success(t("webIconUploaded"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const snippet = useMemo(() => {
    if (!bot?.web_key) return "";
    // Appearance is driven from this tab (DB) via the public /config endpoint,
    // so the snippet only carries the key (and an optional language).
    return `<script src="${origin}/smrtbot-widget.js"\n        data-key="${bot.web_key}"\n        data-lang="he"\n        async></script>`;
  }, [bot?.web_key, origin]);

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

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("webIcon")}</label>
            <div className="flex items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted/40">
                {iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={iconUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Upload className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ICON_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => onPickIcon(e.target.files?.[0] ?? null)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="me-1 h-3.5 w-3.5" />
                  {uploading ? t("webIconUploading") : iconUrl ? t("webIconReplace") : t("webIconUpload")}
                </Button>
                {iconUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setIconUrl("")}>
                    <X className="me-1 h-3.5 w-3.5" />
                    {t("webIconRemove")}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("webIconHint")}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("webTitleField")}</label>
              <Input dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={bot.name} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("webSubtitle")}</label>
              <Input dir="auto" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("webSize")}</label>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              >
                <option value="compact">{t("webSizeCompact")}</option>
                <option value="standard">{t("webSizeStandard")}</option>
                <option value="large">{t("webSizeLarge")}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("webPosition")}</label>
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              >
                <option value="right">{t("webPositionRight")}</option>
                <option value="left">{t("webPositionLeft")}</option>
              </select>
            </div>
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
