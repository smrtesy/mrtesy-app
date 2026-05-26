"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";

type AgeGroup = "child" | "teen" | "adult" | "elderly";
type Gender = "male" | "female" | "neutral";
type VoiceType = "rapid" | "pro";

export function CharacterFormDialog({ onCreated }: { onCreated?: () => void }) {
  const t = useTranslations("smrtVoice.characters");
  const tf = useTranslations("smrtVoice.characters.form");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<"he" | "en">("he");
  const [voiceType, setVoiceType] = useState<VoiceType>("pro");
  const [ageGroup, setAgeGroup] = useState<AgeGroup | "">("");
  const [gender, setGender] = useState<Gender | "">("");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setDisplayName("");
    setDescription("");
    setLanguage("he");
    setVoiceType("pro");
    setAgeGroup("");
    setGender("");
    setPersonalityPrompt("");
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/voice/characters", {
        method: "POST",
        body: {
          name,
          display_name: displayName || undefined,
          description: description || undefined,
          language,
          voice_type: voiceType,
          age_group: ageGroup || undefined,
          gender: gender || undefined,
          personality_prompt: personalityPrompt || undefined,
        },
      });
      setOpen(false);
      reset();
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("new")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("new")}</DialogTitle>
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

          <div className="grid grid-cols-2 gap-3">
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
            <div className="space-y-1">
              <label className="text-sm font-medium">{tf("voiceTypeLabel")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={voiceType}
                onChange={(e) => setVoiceType(e.target.value as VoiceType)}
              >
                <option value="pro">{tf("voiceTypePro")}</option>
                <option value="rapid">{tf("voiceTypeRapid")}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{tf("ageGroupLabel")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={ageGroup}
                onChange={(e) => setAgeGroup(e.target.value as AgeGroup | "")}
              >
                <option value="">{tf("ageGroupNone")}</option>
                <option value="child">{tf("ageGroupChild")}</option>
                <option value="teen">{tf("ageGroupTeen")}</option>
                <option value="adult">{tf("ageGroupAdult")}</option>
                <option value="elderly">{tf("ageGroupElderly")}</option>
              </select>
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

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              {tf("submit")}
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
