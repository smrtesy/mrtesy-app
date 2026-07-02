"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

import { CharacterFormDialog } from "./CharacterFormDialog";

interface Character {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  resemble_voice_id: string | null;
  voice_status: "none" | "training" | "ready";
}

export function CharactersList() {
  const t = useTranslations("smrtVoice.characters");
  const locale = useLocale();
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCharacters = useCallback(async () => {
    try {
      const { characters } = await api<{ characters: Character[] }>(
        "/api/voice/characters",
      );
      setCharacters(characters);
      // Nudge any still-"training" characters: hitting voice-status flips them
      // to "ready" server-side once Resemble finishes the async upgrade.
      const training = characters.filter((c) => c.voice_status === "training");
      if (training.length > 0) {
        const results = await Promise.all(
          training.map((c) =>
            api<{ status: string | null }>(`/api/voice/characters/${c.id}/voice-status`)
              .then((r) => r.status)
              .catch(() => null),
          ),
        );
        const READY = new Set(["ready", "completed", "active", "done", "available"]);
        if (results.some((s) => s && READY.has(s.toLowerCase()))) {
          const { characters: fresh } = await api<{ characters: Character[] }>("/api/voice/characters");
          setCharacters(fresh);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchCharacters();
    const onFocus = () => fetchCharacters();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchCharacters]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (characters === null) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CharacterFormDialog onCreated={fetchCharacters} />
      </div>
      {characters.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {characters.map((c) => (
            <Link key={c.id} href={`/${locale}/voice/characters/${c.id}`}>
              <Card className="hover:bg-accent transition-colors">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{c.display_name ?? c.name}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground space-y-1">
                  <div>{c.description ?? "—"}</div>
                  <div className="text-xs">
                    {c.voice_status === "training" ? (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                        {t("training")}
                      </Badge>
                    ) : c.resemble_voice_id ? (
                      `✓ ${t("voiceReady")}`
                    ) : (
                      t("noVoice")
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
