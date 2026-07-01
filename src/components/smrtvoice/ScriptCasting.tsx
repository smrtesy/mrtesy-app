"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Speaker {
  speaker_name: string;
  character_id: string | null;
  resemble_voice_id: string | null;
}
interface Character {
  id: string;
  name: string;
  display_name: string | null;
  resemble_voice_id: string | null;
}
interface StockVoice {
  uuid: string;
  name?: string;
}

/**
 * Per-script casting: each speaker gets a dropdown — my characters first,
 * then Resemble stock voices. Selection is encoded as `char:<id>` or
 * `voice:<uuid>`; saved via PATCH /speakers.
 */
export function ScriptCasting({
  scriptId,
  onSaved,
}: {
  scriptId: string;
  onSaved?: () => void;
}) {
  const t = useTranslations("smrtVoice.casting");
  const [speakers, setSpeakers] = useState<Speaker[] | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [stock, setStock] = useState<StockVoice[]>([]);
  // speaker_name → encoded value ("" | char:<id> | voice:<uuid>)
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ speakers }, { characters }] = await Promise.all([
        api<{ speakers: Speaker[] }>(`/api/voice/scripts/${scriptId}/speakers`),
        api<{ characters: Character[] }>("/api/voice/characters"),
      ]);
      setSpeakers(speakers);
      setCharacters(characters);
      const initial: Record<string, string> = {};
      for (const s of speakers) {
        if (s.character_id) initial[s.speaker_name] = `char:${s.character_id}`;
        else if (s.resemble_voice_id) initial[s.speaker_name] = `voice:${s.resemble_voice_id}`;
        else initial[s.speaker_name] = "";
      }
      setChoice(initial);

      // Stock voices are owner/admin-gated; degrade gracefully if forbidden.
      try {
        const { voices } = await api<{ voices: StockVoice[] }>("/api/voice/resemble/voices");
        setStock(voices ?? []);
      } catch {
        setStock([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [scriptId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave() {
    if (!speakers) return;
    setBusy(true);
    try {
      const payload = speakers.map((s) => {
        const v = choice[s.speaker_name] ?? "";
        if (v.startsWith("char:")) {
          return { speaker_name: s.speaker_name, character_id: v.slice(5), resemble_voice_id: null };
        }
        if (v.startsWith("voice:")) {
          return { speaker_name: s.speaker_name, character_id: null, resemble_voice_id: v.slice(6) };
        }
        return { speaker_name: s.speaker_name, character_id: null, resemble_voice_id: null };
      });
      await api(`/api/voice/scripts/${scriptId}/speakers`, {
        method: "PATCH",
        body: { speakers: payload },
      });
      toast.success(t("saved"));
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (speakers === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (speakers.length === 0) return <p className="text-sm text-muted-foreground">{t("noSpeakers")}</p>;

  // Resemble voices that don't already back one of my characters (avoid dupes).
  const myVoiceIds = new Set(characters.map((c) => c.resemble_voice_id).filter(Boolean));
  const stockVoices = stock.filter((v) => !myVoiceIds.has(v.uuid));

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div>
          <h3 className="text-base font-semibold">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>

        <div className="space-y-2">
          {speakers.map((s) => (
            <div key={s.speaker_name} className="flex items-center gap-3">
              <div className="w-32 shrink-0 text-sm font-medium truncate" dir="rtl">
                {s.speaker_name}
              </div>
              <select
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                value={choice[s.speaker_name] ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [s.speaker_name]: e.target.value }))}
              >
                <option value="">{t("none")}</option>
                <optgroup label={t("myCharacters")}>
                  {characters.map((c) => (
                    <option key={c.id} value={`char:${c.id}`}>
                      {(c.display_name ?? c.name) + (c.resemble_voice_id ? "" : ` ${t("noVoiceYet")}`)}
                    </option>
                  ))}
                </optgroup>
                {stockVoices.length > 0 && (
                  <optgroup label={t("stockVoices")}>
                    {stockVoices.map((v) => (
                      <option key={v.uuid} value={`voice:${v.uuid}`}>
                        {v.name || v.uuid}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button onClick={onSave} disabled={busy} size="sm">
            {busy ? t("saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
