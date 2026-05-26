"use client";

import { useState } from "react";
import { toast } from "sonner";

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

interface Props {
  characterId: string;
  onCreated?: () => void;
}

export function VoiceProfileEditor({ characterId, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [exaggeration, setExaggeration] = useState(0.5);
  const [pitch, setPitch] = useState(0);
  const [pace, setPace] = useState<"slow" | "normal" | "fast">("normal");
  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName("");
    setExaggeration(0.5);
    setPitch(0);
    setPace("normal");
    setPrompt("");
    setContext("");
    setIsDefault(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/voice/profiles", {
        method: "POST",
        body: {
          character_id: characterId,
          profile_name: name,
          exaggeration,
          pitch,
          speaking_pace: pace,
          resemble_prompt: prompt || undefined,
          context: context || undefined,
          is_default: isDefault,
        },
      });
      toast.success("פרופיל נוצר");
      setOpen(false);
      reset();
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">+ פרופיל</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>פרופיל קול חדש</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">שם פרופיל</label>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Excited, Whisper, Normal..."
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs">Exaggeration</label>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={exaggeration}
                onChange={(e) => setExaggeration(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs">Pitch</label>
              <Input
                type="number"
                step="0.5"
                min="-10"
                max="10"
                value={pitch}
                onChange={(e) => setPitch(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs">Pace</label>
              <select
                className="w-full rounded-md border bg-background px-2 py-2 text-sm"
                value={pace}
                onChange={(e) => setPace(e.target.value as "slow" | "normal" | "fast")}
              >
                <option value="slow">slow</option>
                <option value="normal">normal</option>
                <option value="fast">fast</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Resemble prompt (English)</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Speak with quiet sadness"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Context</label>
            <Input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="excited / sad / normal"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            פרופיל ברירת מחדל
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              צור
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
