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
  extra_character_ids?: string[] | null;
  resemble_voice_id: string | null;
  skip?: boolean;
  line_count?: number;
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
  // speaker_name → additional character ids (multi-voice: line rendered by each)
  const [extras, setExtras] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
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
      const initialExtras: Record<string, string[]> = {};
      for (const s of speakers) {
        if (s.skip) initial[s.speaker_name] = "skip";
        else if (s.character_id) initial[s.speaker_name] = `char:${s.character_id}`;
        else if (s.resemble_voice_id) initial[s.speaker_name] = `voice:${s.resemble_voice_id}`;
        else initial[s.speaker_name] = "";
        initialExtras[s.speaker_name] = s.extra_character_ids ?? [];
      }
      setChoice(initial);
      setExtras(initialExtras);

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
        // Extra voices only apply when a primary character is cast (and never
        // include the primary itself).
        const primaryCharId = v.startsWith("char:") ? v.slice(5) : null;
        const extraIds =
          v === "skip" || v === ""
            ? []
            : (extras[s.speaker_name] ?? []).filter((id) => id !== primaryCharId);
        if (v === "skip") {
          return { speaker_name: s.speaker_name, character_id: null, extra_character_ids: [], resemble_voice_id: null, skip: true };
        }
        if (v.startsWith("char:")) {
          return { speaker_name: s.speaker_name, character_id: v.slice(5), extra_character_ids: extraIds, resemble_voice_id: null, skip: false };
        }
        if (v.startsWith("voice:")) {
          return { speaker_name: s.speaker_name, character_id: null, extra_character_ids: extraIds, resemble_voice_id: v.slice(6), skip: false };
        }
        return { speaker_name: s.speaker_name, character_id: null, extra_character_ids: [], resemble_voice_id: null, skip: false };
      });
      await api(`/api/voice/scripts/${scriptId}/speakers`, {
        method: "PATCH",
        body: { speakers: payload },
      });
      toast.success(t("saved"));
      setSaved(true);
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
          {speakers.map((s) => {
            const v = choice[s.speaker_name] ?? "";
            const hasVoice = v.startsWith("char:") || v.startsWith("voice:");
            const primaryCharId = v.startsWith("char:") ? v.slice(5) : null;
            const selectedExtras = (extras[s.speaker_name] ?? []).filter((id) => id !== primaryCharId);
            const charName = (id: string) => {
              const c = characters.find((x) => x.id === id);
              return c ? (c.display_name ?? c.name) : id;
            };
            const addable = characters.filter(
              (c) => c.resemble_voice_id && c.id !== primaryCharId && !selectedExtras.includes(c.id),
            );
            return (
              <div key={s.speaker_name} className="space-y-1.5">
                <div className="flex items-center gap-3">
                  <div className="w-36 shrink-0 text-sm font-medium truncate" dir="rtl">
                    {s.speaker_name}
                    {typeof s.line_count === "number" && (
                      <span className="text-muted-foreground font-normal"> ({s.line_count})</span>
                    )}
                  </div>
                  <select
                    className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                    value={v}
                    onChange={(e) => {
                      setSaved(false);
                      setChoice((c) => ({ ...c, [s.speaker_name]: e.target.value }));
                    }}
                  >
                    <option value="">{t("none")}</option>
                    <option value="skip">{t("skip")}</option>
                    <optgroup label={t("myCharacters")}>
                      {characters.map((c) => (
                        <option key={c.id} value={`char:${c.id}`}>
                          {(c.display_name ?? c.name) + (c.resemble_voice_id ? "" : ` ${t("noVoiceYet")}`)}
                        </option>
                      ))}
                    </optgroup>
                    {stockVoices.length > 0 && (
                      <optgroup label={t("stockVoices")}>
                        {stockVoices.map((sv) => (
                          <option key={sv.uuid} value={`voice:${sv.uuid}`}>
                            {sv.name || sv.uuid}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                {/* Multi-voice: record this speaker's lines with extra voices too
                    (one take per voice). Only when a primary voice is set. */}
                {hasVoice && (
                  <div className="flex flex-wrap items-center gap-1.5 ps-[9.5rem]" dir="rtl">
                    <span className="text-xs text-muted-foreground">{t("alsoVoices")}</span>
                    {selectedExtras.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                      >
                        {charName(id)}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t("removeVoice")}
                          onClick={() => {
                            setSaved(false);
                            setExtras((e) => ({
                              ...e,
                              [s.speaker_name]: (e[s.speaker_name] ?? []).filter((x) => x !== id),
                            }));
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {addable.length > 0 && (
                      <select
                        className="rounded-md border bg-background px-2 py-1 text-xs"
                        value=""
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id) return;
                          setSaved(false);
                          setExtras((prev) => ({
                            ...prev,
                            [s.speaker_name]: [
                              ...(prev[s.speaker_name] ?? []).filter((x) => x !== primaryCharId),
                              id,
                            ],
                          }));
                        }}
                      >
                        <option value="">+ {t("addVoice")}</option>
                        {addable.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.display_name ?? c.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button onClick={onSave} disabled={busy || saved} size="sm" variant={saved ? "outline" : "default"}>
            {busy ? t("saving") : saved ? `✓ ${t("saved")}` : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
