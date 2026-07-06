"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SpellCheck, Plus, Trash2, Check, Sparkles, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface Entry {
  id: string;
  original_word: string;
  pronounced_as: string;
  language: "he" | "en";
  category: string;
  notes: string | null;
}

interface Suggestions {
  hebrew: string[];
  latin: string[];
}

/**
 * Org pronunciation lexicon manager. Compact by design: a single quiet entry
 * point (icon + title) that expands to the add form + list on demand.
 * `pronounced_as` is a phonetic respelling (Hebrew or Latin), NOT niqqud.
 */
export function LexiconManager() {
  const t = useTranslations("smrtVoice.lexicon");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  // Add-form state.
  const [word, setWord] = useState("");
  const [replacement, setReplacement] = useState("");
  const [language, setLanguage] = useState<"he" | "en">("he");
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const fetchEntries = useCallback(async () => {
    try {
      const { entries } = await api<{ entries: Entry[] }>("/api/voice/lexicon");
      setEntries(entries);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    if (open && entries === null) fetchEntries();
  }, [open, entries, fetchEntries]);

  async function addEntry() {
    if (!word.trim() || !replacement.trim()) return;
    setSaving(true);
    try {
      await api("/api/voice/lexicon", {
        method: "POST",
        body: {
          original_word: word.trim(),
          pronounced_as: replacement.trim(),
          language,
        },
      });
      setWord("");
      setReplacement("");
      setSuggestions(null);
      await fetchEntries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(id: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    try {
      await api(`/api/voice/lexicon/${id}`, { method: "DELETE" });
      await fetchEntries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function suggest() {
    if (!word.trim()) return;
    setSuggesting(true);
    try {
      const s = await api<Suggestions>("/api/voice/pronunciation/suggest", {
        method: "POST",
        body: { word: word.trim() },
      });
      setSuggestions(s);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to suggest");
    } finally {
      setSuggesting(false);
    }
  }

  function pickSuggestion(value: string, lang: "he" | "en") {
    setReplacement(value);
    setLanguage(lang);
  }

  return (
    <div className="rounded-md border">
      {/* Quiet, collapsed entry point. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-3 text-start"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <SpellCheck className="h-4 w-4" />
          {t("title")}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t p-3" dir="rtl">
          <p className="text-xs text-muted-foreground">{t("hint")}</p>

          {/* Add form */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder={t("wordPlaceholder")}
            />
            <Input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={t("replacementPlaceholder")}
            />
            <div className="flex items-center gap-2">
              <select
                className="rounded-md border bg-background px-2 py-2 text-sm"
                value={language}
                onChange={(e) => setLanguage(e.target.value as "he" | "en")}
                aria-label={t("language")}
              >
                <option value="he">{t("hebrew")}</option>
                <option value="en">{t("latin")}</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={t("suggest")}
                onClick={suggest}
                disabled={suggesting || !word.trim()}
              >
                <Sparkles className={`h-4 w-4 ${suggesting ? "animate-pulse" : ""}`} />
              </Button>
              <Button type="button" size="icon" onClick={addEntry} disabled={saving || !word.trim() || !replacement.trim()} title={t("add")}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* AI suggestions as chips (Hebrew + Latin), click to fill. */}
          {suggestions && (
            <div className="space-y-1.5 rounded-md bg-muted/40 p-2 text-xs">
              {suggestions.hebrew.length === 0 && suggestions.latin.length === 0 && (
                <span className="text-muted-foreground">{t("noSuggestions")}</span>
              )}
              {suggestions.hebrew.length > 0 && (
                <SuggestChips label={t("hebrew")} items={suggestions.hebrew} onPick={(v) => pickSuggestion(v, "he")} />
              )}
              {suggestions.latin.length > 0 && (
                <SuggestChips label={t("latin")} items={suggestions.latin} onPick={(v) => pickSuggestion(v, "en")} />
              )}
            </div>
          )}

          {/* Entry list */}
          {entries === null ? (
            <p className="text-sm text-muted-foreground">…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{e.original_word}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="truncate" dir={e.language === "en" ? "ltr" : "rtl"}>
                      {e.pronounced_as}
                    </span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      {e.language === "en" ? t("latin") : t("hebrew")}
                    </span>
                  </span>
                  <Button variant="ghost" size="icon" onClick={() => deleteEntry(e.id)} title={t("delete")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestChips({
  label,
  items,
  onPick,
}: {
  label: string;
  items: string[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">{label}:</span>
      {items.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onPick(s)}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 hover:bg-accent"
          dir="auto"
        >
          {s}
          <Check className="h-3 w-3 opacity-40" />
        </button>
      ))}
    </div>
  );
}
