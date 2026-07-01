"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

import { VoiceCloneUploader } from "./VoiceCloneUploader";
import { CharacterFormDialog } from "./CharacterFormDialog";

interface Character {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  resemble_voice_id: string | null;
  resemble_model: string;
  language: "he" | "en";
  age_years: number | null;
  gender: "male" | "female" | "neutral" | null;
  personality_prompt: string | null;
}

export function CharacterDetails({ characterId }: { characterId: string }) {
  const tf = useTranslations("smrtVoice.characters.form");
  const [character, setCharacter] = useState<Character | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { character } = await api<{ character: Character }>(
        `/api/voice/characters/${characterId}`,
      );
      setCharacter(character);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [characterId]);

  useEffect(() => {
    refresh();
    // Refetch when the tab regains focus — cheap way to reflect changes made
    // elsewhere (e.g. a clone finishing, a voice deleted in the library).
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!character) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{character.display_name ?? character.name}</h1>
          <p className="text-muted-foreground">{character.description ?? "—"}</p>
        </div>
        <CharacterFormDialog
          character={{
            id: character.id,
            name: character.name,
            display_name: character.display_name,
            description: character.description,
            language: character.language,
            age_years: character.age_years,
            gender: character.gender,
            personality_prompt: character.personality_prompt,
          }}
          onSaved={refresh}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Voice</CardTitle>
        </CardHeader>
        <CardContent className="text-sm grid grid-cols-2 gap-2">
          <Stat label={tf("nameLabel")} value={character.name} />
          <Stat label={tf("languageLabel")} value={character.language === "he" ? "עברית" : "English"} />
          {character.age_years != null && <Stat label={tf("ageYearsLabel")} value={String(character.age_years)} />}
          {character.gender && (
            <Stat
              label={tf("genderLabel")}
              value={
                character.gender === "male"
                  ? tf("genderMale")
                  : character.gender === "female"
                    ? tf("genderFemale")
                    : tf("genderNeutral")
              }
            />
          )}
          <Stat label="Voice ID" value={character.resemble_voice_id ?? "—"} />
          <Stat label="Model" value={character.resemble_model} />
        </CardContent>
      </Card>

      <VoiceCloneUploader
        characterId={characterId}
        hasExistingVoice={!!character.resemble_voice_id}
        onCloned={refresh}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium break-all">{value}</div>
    </div>
  );
}
