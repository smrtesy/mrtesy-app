"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Character {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  resemble_voice_id: string | null;
  voice_type: "rapid" | "pro";
}

export function CharactersList() {
  const t = useTranslations("smrtVoice.characters");
  const locale = useLocale();
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { characters } = await api<{ characters: Character[] }>(
          "/api/voice/characters",
        );
        if (mounted) setCharacters(characters);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (characters === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (characters.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
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
                {c.voice_type} · {c.resemble_voice_id ? "cloned" : "no voice yet"}
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
