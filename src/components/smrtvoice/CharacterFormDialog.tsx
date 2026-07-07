"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";

type Gender = "male" | "female" | "neutral";

// Curated Resemble WRAP tags that make sense as a persistent per-character
// baseline (register / pace / volume). value = the real tag; key = i18n label.
const BASELINE_TAGS: { value: string; key: string }[] = [
  { value: "higher-pitch", key: "higherPitch" },
  { value: "lower-pitch", key: "lowerPitch" },
  { value: "slow", key: "slow" },
  { value: "fast", key: "fast" },
  { value: "soft", key: "soft" },
  { value: "loud", key: "loud" },
  { value: "emphasis", key: "emphasis" },
  { value: "whisper", key: "whisper" },
];

interface CharacterInit {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  language: "he" | "en";
  age_years: number | null;
  gender: Gender | null;
  personality_prompt: string | null;
  style_baseline_tags: string[] | null;
}

/**
 * Create OR edit a character. Pass `character` to edit (PATCH); omit for create
 * (POST). A character is just a named voice — the name is a label, casting to
 * script speakers happens separately.
 */
export function CharacterFormDialog({
  onCreated,
  onSaved,
  character,
}: {
  onCreated?: () => void;
  onSaved?: () => void;
  character?: CharacterInit;
}) {
  const t = useTranslations("smrtVoice.characters");
  const tf = useTranslations("smrtVoice.characters.form");
  const router = useRouter();
  const locale = useLocale();
  const isEdit = !!character;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(character?.name ?? "");
  const [displayName, setDisplayName] = useState(character?.display_name ?? "");
  const [description, setDescription] = useState(character?.description ?? "");
  const [language, setLanguage] = useState<"he" | "en">(character?.language ?? "he");
  const [ageYears, setAgeYears] = useState<string>(
    character?.age_years != null ? String(character.age_years) : "",
  );
  const [gender, setGender] = useState<Gender | "">(character?.gender ?? "");
  const [personalityPrompt, setPersonalityPrompt] = useState(character?.personality_prompt ?? "");
  const [baselineTags, setBaselineTags] = useState<string[]>(
    character?.style_baseline_tags ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    if (isEdit) return; // keep edit values; dialog just closes
    setName("");
    setDisplayName("");
    setDescription("");
    setLanguage("he");
    setAgeYears("");
    setGender("");
    setPersonalityPrompt("");
    setBaselineTags([]);
    setError(null);
  }

  function toggleBaseline(value: string) {
    setBaselineTags((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      name,
      display_name: displayName || undefined,
      description: description || undefined,
      language,
      age_years: ageYears.trim() === "" ? undefined : Number(ageYears),
      gender: gender || undefined,
      personality_prompt: personalityPrompt || undefined,
      style_baseline_tags: baselineTags,
    };
    try {
      if (isEdit) {
        await api(`/api/voice/characters/${character!.id}`, { method: "PATCH", body });
        setOpen(false);
        onSaved?.();
      } else {
        const { character: created } = await api<{ character: { id: string } }>(
          "/api/voice/characters",
          { method: "POST", body },
        );
        setOpen(false);
        reset();
        onCreated?.();
        if (created?.id) router.push(`/${locale}/voice/characters/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        {isEdit ? (
          <Button variant="outline" size="sm">{tf("edit")}</Button>
        ) : (
          <Button>{t("new")}</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? tf("editTitle") : t("new")}</DialogTitle>
          <DialogDescription className="sr-only">{tf("dialogDesc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("nameLabel")}</label>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tf("namePlaceholder")}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("displayNameLabel")}</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={tf("displayNamePlaceholder")}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("descriptionLabel")}</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tf("descriptionPlaceholder")}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("languageLabel")}</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={language}
              onChange={(e) => setLanguage(e.target.value as "he" | "en")}
            >
              <option value="he">עברית</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{tf("ageYearsLabel")}</label>
              <Input
                type="number"
                min={0}
                max={120}
                inputMode="numeric"
                value={ageYears}
                onChange={(e) => setAgeYears(e.target.value)}
                placeholder={tf("ageYearsPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tf("genderLabel")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender | "")}
              >
                <option value="">{tf("genderNone")}</option>
                <option value="male">{tf("genderMale")}</option>
                <option value="female">{tf("genderFemale")}</option>
                <option value="neutral">{tf("genderNeutral")}</option>
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("personalityPromptLabel")}</label>
            <Textarea
              value={personalityPrompt}
              onChange={(e) => setPersonalityPrompt(e.target.value)}
              placeholder={tf("personalityPromptPlaceholder")}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{tf("styleBaselineLabel")}</label>
            <p className="text-xs text-muted-foreground">{tf("styleBaselineHint")}</p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {BASELINE_TAGS.map(({ value, key }) => {
                const on = baselineTags.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleBaseline(value)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background hover:bg-muted"
                    }`}
                  >
                    {tf(`styleTag.${key}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {!isEdit && <p className="text-xs text-muted-foreground">{tf("cloneHint")}</p>}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              {isEdit ? (busy ? tf("saving") : tf("save")) : tf("submit")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tf("cancel")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
