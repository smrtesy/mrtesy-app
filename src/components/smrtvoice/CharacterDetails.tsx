"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Character {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  resemble_voice_id: string | null;
  resemble_model: string;
  voice_type: "rapid" | "pro";
  language: "he" | "en";
  default_exaggeration: number;
  default_pitch: number;
  default_pace: string;
}

interface VoiceProfile {
  id: string;
  profile_name: string;
  exaggeration: number;
  pitch: number;
  speaking_pace: string;
  resemble_prompt: string | null;
  is_default: boolean;
}

export function CharacterDetails({ characterId }: { characterId: string }) {
  const [character, setCharacter] = useState<Character | null>(null);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [{ character }, { profiles }] = await Promise.all([
          api<{ character: Character }>(`/api/voice/characters/${characterId}`),
          api<{ profiles: VoiceProfile[] }>(
            `/api/voice/characters/${characterId}/profiles`,
          ),
        ]);
        if (!mounted) return;
        setCharacter(character);
        setProfiles(profiles);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Unknown error");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [characterId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!character) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{character.display_name ?? character.name}</h1>
        <p className="text-muted-foreground">{character.description ?? "—"}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Voice</CardTitle>
        </CardHeader>
        <CardContent className="text-sm grid grid-cols-2 gap-2">
          <Stat label="Type" value={character.voice_type} />
          <Stat label="Language" value={character.language} />
          <Stat label="Resemble model" value={character.resemble_model} />
          <Stat label="Voice ID" value={character.resemble_voice_id ?? "—"} />
          <Stat label="Exaggeration" value={String(character.default_exaggeration)} />
          <Stat label="Pitch" value={String(character.default_pitch)} />
          <Stat label="Pace" value={character.default_pace} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Profiles</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {profiles.length === 0 ? (
            <p className="text-muted-foreground">No profiles yet.</p>
          ) : (
            profiles.map((p) => (
              <div key={p.id} className="border rounded-md p-2">
                <div className="font-medium">
                  {p.profile_name}
                  {p.is_default && " · default"}
                </div>
                <div className="text-xs text-muted-foreground">
                  exaggeration {p.exaggeration} · pitch {p.pitch} · {p.speaking_pace}
                </div>
                {p.resemble_prompt && (
                  <div className="text-xs italic mt-1">{p.resemble_prompt}</div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
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
