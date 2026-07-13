"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Lightbulb, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

const LANG_FLAG: Record<string, string> = { he: "🇮🇱", en: "🇺🇸" };

interface Learning {
  original_word: string;
  pronounced_as: string;
  kind: "spelling" | "punctuation";
  chosen: number;
  total: number;
}
interface VoiceInsight {
  key: string;
  character_id: string | null;
  character_name: string | null;
  resemble_voice_id: string | null;
  language: string | null;
  learnings: Learning[];
  chosen_total: number;
  pair_count: number;
}

type KindFilter = "all" | "spelling" | "punctuation";

/**
 * "What the system learned" dashboard. Reads GET /voice/insights — every
 * respelling/punctuation pair the learning system has recorded, grouped by
 * voice and ranked by how often the user KEPT it (⭐). The top respelling per
 * original word is the current recommendation for that voice.
 *
 * Read-only: nothing here auto-applies. It's the window into the learning.
 */
export function VoiceInsights() {
  const t = useTranslations("smrtVoice.insights");
  const [voices, setVoices] = useState<VoiceInsight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { voices } = await api<{ voices: VoiceInsight[] }>("/api/voice/insights");
        if (alive) setVoices(voices);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : t("loadError"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  const filters: KindFilter[] = ["all", "spelling", "punctuation"];
  const filterLabel: Record<KindFilter, string> = {
    all: t("filterAll"),
    spelling: t("filterSpelling"),
    punctuation: t("filterPunctuation"),
  };

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (voices === null) {
    return <p className="text-sm text-muted-foreground">…</p>;
  }
  if (voices.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 py-8 text-sm text-muted-foreground">
          <Lightbulb className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{t("empty")}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Compact kind filter — quiet pill toggles, default "all". */}
      <div className="flex items-center gap-1.5">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setKindFilter(f)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              kindFilter === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {filterLabel[f]}
          </button>
        ))}
      </div>

      {voices.map((v) => (
        <VoiceCard key={v.key} voice={v} kindFilter={kindFilter} />
      ))}
    </div>
  );
}

function VoiceCard({ voice, kindFilter }: { voice: VoiceInsight; kindFilter: KindFilter }) {
  const t = useTranslations("smrtVoice.insights");

  // Group learnings by original word, preserving the API's chosen-desc order so
  // the first respelling per word is the recommendation.
  const words = useMemo(() => {
    const byWord = new Map<string, Learning[]>();
    for (const l of voice.learnings) {
      if (kindFilter !== "all" && l.kind !== kindFilter) continue;
      const arr = byWord.get(l.original_word) ?? [];
      arr.push(l);
      byWord.set(l.original_word, arr);
    }
    return [...byWord.entries()];
  }, [voice.learnings, kindFilter]);

  // Meta reflects the ACTIVE filter: distinct original words shown, and how
  // many times the user kept a respelling across them.
  const wordCount = words.length;
  const chosenCount = words.reduce(
    (sum, [, options]) => sum + options.reduce((a, o) => a + o.chosen, 0),
    0,
  );

  const name = voice.character_name || t("noVoice");

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{name}</span>
          {voice.language ? (
            <span className="text-sm">{LANG_FLAG[voice.language] ?? voice.language}</span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {t("voiceMeta", { words: wordCount, chosen: chosenCount })}
          </span>
        </div>

        {words.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noneForFilter")}</p>
        ) : (
          <ul className="space-y-2.5">
            {words.map(([word, options]) => (
              <li key={word} className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t("originalHeader")}: <span dir="auto" className="font-medium text-foreground">{word}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {options.map((o, idx) => {
                    // The first option with any ⭐ is the recommendation.
                    const isRecommended = idx === 0 && o.chosen > 0;
                    return (
                      <div
                        key={o.pronounced_as}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                          isRecommended ? "border-primary bg-primary/5" : "border-border"
                        }`}
                      >
                        <span dir="auto" className="font-medium">{o.pronounced_as}</span>
                        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                          {o.kind === "punctuation" ? t("kindPunctuation") : t("kindSpelling")}
                        </Badge>
                        {isRecommended ? (
                          <span className="inline-flex items-center gap-0.5 text-primary">
                            <Star className="h-3 w-3 fill-current" />
                            {t("recommended")}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground">
                          {o.chosen > 0
                            ? t("chosenStat", { chosen: o.chosen, total: o.total })
                            : t("neverChosen")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
