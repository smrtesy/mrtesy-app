"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { readVoiceCache, writeVoiceCache } from "./voiceCache";

interface Speaker {
  speaker_name: string;
  character_id: string | null;
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
  display_name?: string | null;
}

/**
 * Per-script casting: each speaker gets a dropdown — my characters first,
 * then Resemble voices (the ones I renamed in the Voice Library on top, the
 * rest A→Z). Selection is encoded as `char:<id>` or `voice:<uuid>`; saved via
 * PATCH /speakers.
 *
 * Voices + characters are painted from a shared stale-while-revalidate cache
 * (see voiceCache) so opening a script never blocks on the slow Resemble list
 * fetch; it revalidates in the background.
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
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Collapsed-by-default search that filters the voice options in every
  // dropdown as you type (compact UI: one quiet entry point, expand on demand).
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    // Reset transient state so a prior error / saved flag can't stick when the
    // script changes or a failed load is retried.
    setError(null);
    setSaved(false);
    // Instant paint from the shared cache before the network settles.
    const cached = readVoiceCache();
    if (cached?.chars) setCharacters(cached.chars as Character[]);
    if (cached?.voices) setStock(cached.voices as StockVoice[]);

    try {
      const [{ speakers }, { characters }] = await Promise.all([
        api<{ speakers: Speaker[] }>(`/api/voice/scripts/${scriptId}/speakers`),
        api<{ characters: Character[] }>("/api/voice/characters"),
      ]);
      setSpeakers(speakers);
      setCharacters(characters);
      const initial: Record<string, string> = {};
      for (const s of speakers) {
        if (s.skip) initial[s.speaker_name] = "skip";
        else if (s.character_id) initial[s.speaker_name] = `char:${s.character_id}`;
        else if (s.resemble_voice_id) initial[s.speaker_name] = `voice:${s.resemble_voice_id}`;
        else initial[s.speaker_name] = "";
      }
      setChoice(initial);

      // Stock voices are owner/admin-gated; degrade gracefully if forbidden.
      try {
        const { voices } = await api<{ voices: StockVoice[] }>("/api/voice/resemble/voices");
        setStock(voices ?? []);
        writeVoiceCache({ voices: voices ?? [] });
      } catch {
        if (!cached?.voices) setStock([]);
      }
      writeVoiceCache({ chars: characters });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [scriptId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  async function onSave() {
    if (!speakers) return;
    setBusy(true);
    try {
      const payload = speakers.map((s) => {
        const v = choice[s.speaker_name] ?? "";
        if (v === "skip") {
          return { speaker_name: s.speaker_name, character_id: null, resemble_voice_id: null, skip: true };
        }
        if (v.startsWith("char:")) {
          return { speaker_name: s.speaker_name, character_id: v.slice(5), resemble_voice_id: null, skip: false };
        }
        if (v.startsWith("voice:")) {
          return { speaker_name: s.speaker_name, character_id: null, resemble_voice_id: v.slice(6), skip: false };
        }
        return { speaker_name: s.speaker_name, character_id: null, resemble_voice_id: null, skip: false };
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

  // Voice label = custom name I set in the Voice Library → Resemble name → uuid.
  const voiceLabel = useCallback(
    (v: StockVoice) => v.display_name || v.name || v.uuid,
    [],
  );
  const charLabel = useCallback(
    (c: Character) =>
      (c.display_name ?? c.name) + (c.resemble_voice_id ? "" : ` ${t("noVoiceYet")}`),
    [t],
  );

  // Build the grouped/sorted option lists once, independent of how many
  // speakers there are — every dropdown reuses the same arrays.
  const groups = useMemo(() => {
    const myVoiceIds = new Set(characters.map((c) => c.resemble_voice_id).filter(Boolean));
    // Resemble voices that don't already back one of my characters (avoid dupes).
    const resemble = stock.filter((v) => !myVoiceIds.has(v.uuid));
    const byLabel = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });

    // Named (renamed by me) first, alphabetical; then the rest, alphabetical.
    // Unnamed voices have no display_name, so voiceLabel() falls back to the
    // Resemble name for them — one sort key works for both groups.
    const named = resemble
      .filter((v) => (v.display_name ?? "").trim())
      .sort((a, b) => byLabel(voiceLabel(a), voiceLabel(b)));
    const rest = resemble
      .filter((v) => !(v.display_name ?? "").trim())
      .sort((a, b) => byLabel(voiceLabel(a), voiceLabel(b)));
    return { mine: characters, named, rest };
  }, [characters, stock, voiceLabel]);

  // Apply the free-text filter to each group (matches the label the user sees).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    const hit = (s: string) => s.toLowerCase().includes(q);
    return {
      mine: groups.mine.filter((c) => hit(charLabel(c))),
      named: groups.named.filter((v) => hit(voiceLabel(v))),
      rest: groups.rest.filter((v) => hit(voiceLabel(v))),
    };
  }, [groups, search, charLabel, voiceLabel]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (speakers === null) return <p className="text-sm text-muted-foreground">…</p>;
  if (speakers.length === 0) return <p className="text-sm text-muted-foreground">{t("noSpeakers")}</p>;

  // The set of option values currently visible after filtering — used to keep a
  // speaker's already-chosen voice rendered even when the filter would hide it,
  // so the native <select> still shows the right name.
  const visibleValues = new Set<string>([
    "",
    "skip",
    ...filtered.mine.map((c) => `char:${c.id}`),
    ...filtered.named.map((v) => `voice:${v.uuid}`),
    ...filtered.rest.map((v) => `voice:${v.uuid}`),
  ]);
  const labelForValue = (val: string): string => {
    if (val.startsWith("char:")) {
      const c = characters.find((x) => x.id === val.slice(5));
      return c ? charLabel(c) : val.slice(5);
    }
    if (val.startsWith("voice:")) {
      const v = stock.find((x) => x.uuid === val.slice(6));
      return v ? voiceLabel(v) : val.slice(6);
    }
    return val;
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{t("title")}</h3>
            <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
          {!searchOpen && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              title={t("searchVoices")}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
        </div>

        {searchOpen && (
          <div className="relative">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  setSearchOpen(false);
                }
              }}
              placeholder={t("searchVoices")}
              className="ps-8 pe-8"
            />
            <button
              type="button"
              title={t("closeSearch")}
              onClick={() => {
                setSearch("");
                setSearchOpen(false);
              }}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="space-y-2">
          {speakers.map((s) => {
            const value = choice[s.speaker_name] ?? "";
            // Keep the current selection visible even if the filter hid it.
            const injectSelected = value !== "" && !visibleValues.has(value);
            return (
              <div key={s.speaker_name} className="flex items-center gap-3">
                <div className="w-36 shrink-0 text-sm font-medium truncate" dir="rtl">
                  {s.speaker_name}
                  {typeof s.line_count === "number" && (
                    <span className="text-muted-foreground font-normal"> ({s.line_count})</span>
                  )}
                </div>
                <select
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  value={value}
                  onChange={(e) => {
                    setSaved(false);
                    setChoice((c) => ({ ...c, [s.speaker_name]: e.target.value }));
                  }}
                >
                  <option value="">{t("none")}</option>
                  <option value="skip">{t("skip")}</option>
                  {injectSelected && <option value={value}>{labelForValue(value)}</option>}
                  {filtered.mine.length > 0 && (
                    <optgroup label={t("myCharacters")}>
                      {filtered.mine.map((c) => (
                        <option key={c.id} value={`char:${c.id}`}>
                          {charLabel(c)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {filtered.named.length > 0 && (
                    <optgroup label={t("myNamedVoices")}>
                      {filtered.named.map((v) => (
                        <option key={v.uuid} value={`voice:${v.uuid}`}>
                          {voiceLabel(v)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {filtered.rest.length > 0 && (
                    <optgroup label={t("stockVoices")}>
                      {filtered.rest.map((v) => (
                        <option key={v.uuid} value={`voice:${v.uuid}`}>
                          {voiceLabel(v)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
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
