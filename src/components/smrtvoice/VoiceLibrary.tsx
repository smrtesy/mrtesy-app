"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Play, Trash2, Sparkles, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface Account {
  email: string | null;
  name: string | null;
  total_voices: number;
  credits_available: number | null;
  billing_url: string;
}
interface Voice {
  uuid: string;
  name?: string;
  language?: string;
  has_preview?: boolean;
  [k: string]: unknown;
}
interface Character {
  id: string;
  name: string;
  resemble_voice_id: string | null;
  language: "he" | "en";
}

const LANG_FLAG: Record<string, string> = { he: "🇮🇱", en: "🇺🇸" };

export function VoiceLibrary() {
  const t = useTranslations("smrtVoice.library");
  const [account, setAccount] = useState<Account | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [chars, setChars] = useState<Character[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "stock">("all");
  const [lang, setLang] = useState<string>("");
  const [sampling, setSampling] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    if (refresh) setRefreshing(true);
    const q = refresh ? "?refresh=true" : "";
    try {
      const [acct, vs, cs] = await Promise.all([
        api<Account>(`/api/voice/resemble/account${q}`).catch(() => null),
        api<{ voices: Voice[] }>(`/api/voice/resemble/voices${q}`),
        api<{ characters: Character[] }>("/api/voice/characters").catch(() => ({ characters: [] })),
      ]);
      setAccount(acct);
      setVoices(vs.voices ?? []);
      setChars(cs.characters ?? []);
      const seed: Record<string, boolean> = {};
      for (const v of vs.voices ?? []) if (v.has_preview) seed[v.uuid] = true;
      setPreviews(seed);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadError"));
    } finally {
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // uuid → my character (the reliable "mine" signal + language source).
  const mine = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of chars) if (c.resemble_voice_id) m.set(c.resemble_voice_id, c);
    return m;
  }, [chars]);

  function voiceLang(v: Voice): string | null {
    const c = mine.get(v.uuid);
    if (c) return c.language;
    if (typeof v.language === "string") return v.language;
    return null;
  }

  const filtered = useMemo(() => {
    if (!voices) return [];
    const q = search.trim().toLowerCase();
    return voices.filter((v) => {
      const isMine = mine.has(v.uuid);
      if (filter === "mine" && !isMine) return false;
      if (filter === "stock" && isMine) return false;
      if (lang && voiceLang(v) !== lang) return false;
      if (q && !(v.name ?? "").toLowerCase().includes(q) && !v.uuid.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices, search, filter, lang, mine]);

  async function onSample(uuid: string) {
    setSampling(uuid);
    try {
      const { cost } = await api<{ ok: boolean; cost: number }>(
        `/api/voice/resemble/voices/${uuid}/sample`,
        { method: "POST" },
      );
      setPreviews((p) => ({ ...p, [uuid]: true }));
      toast.success(t("sampleReady", { cost: (cost ?? 0).toFixed(3) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("sampleFailed"));
    } finally {
      setSampling(null);
    }
  }

  async function onPlay(uuid: string) {
    setPlaying(uuid);
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/resemble/voices/${uuid}/sample`,
      );
      const audio = new Audio(audio_url);
      audio.onended = () => setPlaying(null);
      audio.onerror = () => setPlaying(null);
      await audio.play();
    } catch (err) {
      setPlaying(null);
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function onDelete(uuid: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    try {
      await api(`/api/voice/resemble/voices/${uuid}`, { method: "DELETE" });
      toast.success(t("deleted"));
      setVoices((vs) => (vs ?? []).filter((v) => v.uuid !== uuid));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const langs = Array.from(
    new Set((voices ?? []).map((v) => voiceLang(v)).filter(Boolean) as string[]),
  );

  return (
    <div className="space-y-4">
      {/* Account card */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">{t("account")}</div>
            <div className="font-medium">{account?.email ?? "…"}</div>
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">{t("totalVoices")}</div>
            <div className="font-medium">{account?.total_voices ?? (voices?.length ?? "…")}</div>
          </div>
          <div className="space-y-0.5 max-w-xs">
            <div className="text-xs text-muted-foreground">{t("credits")}</div>
            <a
              href={account?.billing_url ?? "https://app.resemble.ai/account/billing"}
              target="_blank"
              rel="noreferrer"
              className="text-primary text-xs underline"
            >
              {t("billingLink")}
            </a>
            <p className="text-[11px] text-muted-foreground">{t("creditsNote")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 me-1 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? t("refreshing") : t("refresh")}
          </Button>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-8"
          />
        </div>
        <div className="flex rounded-md border overflow-hidden text-sm">
          {(["all", "mine", "stock"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-2 ${filter === f ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {f === "all" ? t("filterAll") : f === "mine" ? t("filterMine") : t("filterStock")}
            </button>
          ))}
        </div>
        {langs.length > 0 && (
          <select
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
          >
            <option value="">{t("allLanguages")}</option>
            {langs.map((l) => (
              <option key={l} value={l}>
                {(LANG_FLAG[l] ?? "🌐") + " " + l}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Voices */}
      {voices === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noVoices")}</p>
      ) : (
        <div className="grid gap-2">
          {filtered.map((v) => {
            const isMine = mine.has(v.uuid);
            const l = voiceLang(v);
            const hasPreview = previews[v.uuid];
            return (
              <Card key={v.uuid}>
                <CardContent className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="text-base" title={l ?? ""}>{l ? (LANG_FLAG[l] ?? "🌐") : "🌐"}</span>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{v.name || v.uuid}</div>
                      <div className="text-[11px] text-muted-foreground font-mono truncate">{v.uuid}</div>
                    </div>
                    <Badge variant={isMine ? "default" : "outline"}>
                      {isMine ? t("mine") : t("stock")}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {hasPreview && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("play")}
                        onClick={() => onPlay(v.uuid)}
                        disabled={playing === v.uuid}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onSample(v.uuid)}
                      disabled={sampling === v.uuid}
                    >
                      <Sparkles className="h-4 w-4 me-1" />
                      {sampling === v.uuid ? t("generating") : t("generateSample")}
                    </Button>
                    {isMine && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("delete")}
                        onClick={() => onDelete(v.uuid)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
