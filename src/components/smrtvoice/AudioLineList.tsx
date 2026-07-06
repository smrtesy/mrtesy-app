"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Play,
  Square,
  RefreshCw,
  Settings2,
  RotateCcw,
  X,
  FolderUp,
  Download,
  Sparkles,
  BadgeCheck,
  History,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { DownloadAllButton } from "./DownloadAllButton";

interface Tag {
  tag: string;
  type?: string;
  source?: string;
}

interface Line {
  id: string;
  line_number: number;
  speaker_name: string;
  text_clean: string;
  text_for_tts: string | null;
  tts_body: string | null;
  tags: Tag[] | null;
  emotion: string | null;
  emotion_source: "script" | "llm" | "none" | null;
  resemble_request: Record<string, unknown> | null;
  output_audio_path: string | null;
  output_duration_seconds: number | null;
  status: string;
  approved: boolean;
  redo_requested: boolean;
  redo_reason: string | null;
  redo_instructions: string | null;
}

interface Take {
  id: string;
  text_used: string | null;
  model: string | null;
  output_audio_path: string;
  duration_seconds: number | null;
  cost_usd: number | null;
  created_at: string;
}

interface Suggestions {
  hebrew: string[];
  latin: string[];
}

/** The exact body prefilled into the edit box: what was last sent to Resemble. */
function prefillText(line: Line): string {
  return (line.tts_body ?? line.text_for_tts ?? line.text_clean ?? "").trim();
}

export function AudioLineList({ scriptId }: { scriptId: string }) {
  const t = useTranslations("smrtVoice");
  const locale = useLocale();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // Line numbers from the most recent re-run, so the user can "play the new ones".
  const [newLineNumbers, setNewLineNumbers] = useState<number[]>([]);

  // Edit / send-again panel state.
  const [redoOpenId, setRedoOpenId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [regenLineId, setRegenLineId] = useState<string | null>(null);
  const [suggestWord, setSuggestWord] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  // Take history state (per-line, lazy-loaded on expand).
  const [takesOpenId, setTakesOpenId] = useState<string | null>(null);
  const [takes, setTakes] = useState<Record<string, Take[]>>({});
  // Mirror the open take-list id into a ref so the realtime handler can refresh
  // it without the subscription effect re-subscribing on every toggle.
  const takesOpenIdRef = useRef<string | null>(null);
  useEffect(() => {
    takesOpenIdRef.current = takesOpenId;
  }, [takesOpenId]);

  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef(false);
  // Resolver of the in-flight playOne promise, so stop can unblock the loop.
  const resolveRef = useRef<(() => void) | null>(null);

  const fetchLines = useCallback(async () => {
    try {
      const { lines } = await api<{ lines: Line[] }>(
        `/api/voice/scripts/${scriptId}/lines`,
      );
      setLines(lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [scriptId]);

  const loadTakes = useCallback(async (lineId: string) => {
    try {
      const { takes } = await api<{ takes: Take[] }>(`/api/voice/lines/${lineId}/takes`);
      setTakes((prev) => ({ ...prev, [lineId]: takes }));
    } catch {
      /* takes are supplementary — a failure shouldn't break the list */
    }
  }, []);

  useEffect(() => {
    fetchLines();
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtvoice_audio_${scriptId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "smrtvoice_lines",
          filter: `script_id=eq.${scriptId}`,
        },
        () => {
          fetchLines();
          // A completed re-render also inserts a take; refresh the open list.
          const openId = takesOpenIdRef.current;
          if (openId) loadTakes(openId);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchLines, loadTakes, scriptId]);

  const rendered = (lines ?? []).filter((l) => l.output_audio_path);
  const redoCount = (lines ?? []).filter((l) => l.redo_requested).length;

  async function playUrl(url: string, id: string): Promise<void> {
    await new Promise<void>((resolve) => {
      resolveRef.current = resolve;
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      setPlayingId(id);
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }

  async function playOne(line: Line): Promise<void> {
    if (!line.output_audio_path) return;
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/lines/${line.id}/audio-url`,
      );
      await playUrl(audio_url, line.id);
    } catch {
      /* skip a failed line and continue */
    } finally {
      resolveRef.current = null;
      setPlayingId(null);
    }
  }

  async function downloadBlob(url: string, filename: string) {
    // The `download` attribute is ignored for cross-origin URLs, so a signed
    // Supabase URL just opens inline. Fetch the bytes and download a local
    // object URL instead — that forces a real download dialog.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }

  async function downloadOne(line: Line) {
    if (!line.output_audio_path) return;
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/lines/${line.id}/audio-url`,
      );
      await downloadBlob(
        audio_url,
        `${String(line.line_number).padStart(3, "0")}_${line.speaker_name}.wav`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function playSequence(items: Line[]) {
    const playable = items.filter((l) => l.output_audio_path);
    if (playable.length === 0) return;
    cancelRef.current = false;
    setPlayingAll(true);
    for (const line of playable) {
      if (cancelRef.current) break;
      await playOne(line);
    }
    setPlayingAll(false);
    currentAudioRef.current = null;
  }

  function stopPlayback() {
    cancelRef.current = true;
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    // Unblock the awaiting playOne promise so the sequence loop exits now.
    resolveRef.current?.();
    resolveRef.current = null;
    setPlayingAll(false);
    setPlayingId(null);
  }

  function openEdit(line: Line) {
    const next = redoOpenId === line.id ? null : line.id;
    setRedoOpenId(next);
    setEditText(next ? prefillText(line) : "");
    setSuggestWord("");
    setSuggestions(null);
  }

  // "Send again" — regenerate THIS line. If the text was edited from what was
  // last sent, forward it as a verbatim override; otherwise a plain re-render.
  async function regenerateNow(line: Line) {
    setRegenLineId(line.id);
    try {
      const edited = editText.trim();
      const body = edited && edited !== prefillText(line) ? { text_for_tts: edited } : {};
      await api(`/api/voice/lines/${line.id}/regenerate`, { method: "POST", body });
      setNewLineNumbers([line.line_number]);
      setRedoOpenId(null);
      toast.success(t("studio.redoQueued", { count: 1 }));
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRegenLineId(null);
    }
  }

  // Flag for the batch "rerun redos". Persist any text edit first so the batch
  // run synthesizes exactly what the user typed.
  async function markRedo(line: Line) {
    try {
      const edited = editText.trim();
      if (edited && edited !== prefillText(line)) {
        await api(`/api/voice/lines/${line.id}`, {
          method: "PATCH",
          body: { text_for_tts: edited, tts_body: edited, tags: [] },
        });
      }
      await api(`/api/voice/lines/${line.id}/redo`, { method: "POST" });
      setRedoOpenId(null);
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function clearRedo(lineId: string) {
    try {
      await api(`/api/voice/lines/${lineId}/redo`, { method: "DELETE" });
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function toggleApprove(line: Line) {
    try {
      await api(`/api/voice/lines/${line.id}`, {
        method: "PATCH",
        body: { approved: !line.approved },
      });
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function suggestForLine() {
    if (!suggestWord.trim()) return;
    setSuggesting(true);
    try {
      const s = await api<Suggestions>("/api/voice/pronunciation/suggest", {
        method: "POST",
        body: { word: suggestWord.trim() },
      });
      setSuggestions(s);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSuggesting(false);
    }
  }

  // Insert a chosen suggestion at the caret in the edit box (append if no caret).
  function insertSuggestion(value: string) {
    const el = editRef.current;
    if (!el) {
      setEditText((prev) => (prev ? `${prev} ${value}` : value));
      return;
    }
    const start = el.selectionStart ?? editText.length;
    const end = el.selectionEnd ?? editText.length;
    const next = editText.slice(0, start) + value + editText.slice(end);
    setEditText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + value.length;
      el.setSelectionRange(caret, caret);
    });
  }

  async function rerunRedos() {
    setRerunning(true);
    try {
      const { line_numbers } = await api<{ line_numbers: number[] }>(
        `/api/voice/scripts/${scriptId}/regenerate-redos`,
        { method: "POST" },
      );
      setNewLineNumbers(line_numbers ?? []);
      toast.success(t("studio.redoQueued", { count: line_numbers?.length ?? 0 }));
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRerunning(false);
    }
  }

  function toggleTakes(lineId: string) {
    const next = takesOpenId === lineId ? null : lineId;
    setTakesOpenId(next);
    if (next) loadTakes(next);
  }

  async function playTake(take: Take) {
    stopPlayback();
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/takes/${take.id}/audio-url`,
      );
      await playUrl(audio_url, take.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      resolveRef.current = null;
      setPlayingId(null);
    }
  }

  // takeNo matches the on-screen label (newest-first list → "Take N" at top).
  async function downloadTake(take: Take, lineNumber: number, takeNo: number) {
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/takes/${take.id}/audio-url`,
      );
      await downloadBlob(
        audio_url,
        `${String(lineNumber).padStart(3, "0")}_take${takeNo}.wav`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function saveToDrive() {
    setArchiving(true);
    try {
      const { folder_url, uploaded, skipped } = await api<{
        folder_url: string | null;
        uploaded: number;
        skipped: number;
      }>(`/api/voice/scripts/${scriptId}/archive`, { method: "POST" });
      toast.success(
        t("studio.savedToDrive", { uploaded, skipped: skipped ?? 0 }),
        folder_url ? { action: { label: t("studio.openFolder"), onClick: () => window.open(folder_url, "_blank") } } : undefined,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setArchiving(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;

  // Only offer "play new" for re-rendered lines that have actually finished —
  // a re-queued line keeps its OLD audio (status flips to processing) until the
  // job completes, so gating on completed avoids replaying the stale take.
  const newOnes = rendered.filter(
    (l) => newLineNumbers.includes(l.line_number) && l.status === "completed",
  );

  return (
    <div className="space-y-3">
      {/* Header with quiet icon actions (compact by design). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("audio.title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {rendered.length > 0 &&
            (playingAll ? (
              <Button size="sm" variant="outline" onClick={stopPlayback}>
                <Square className="h-4 w-4 me-1" /> {t("studio.stop")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => playSequence(rendered)}>
                <Play className="h-4 w-4 me-1" /> {t("studio.playAll")}
              </Button>
            ))}
          {newOnes.length > 0 && !playingAll && (
            <Button size="sm" variant="outline" onClick={() => playSequence(newOnes)}>
              <Play className="h-4 w-4 me-1" /> {t("studio.playNew", { count: newOnes.length })}
            </Button>
          )}
          {redoCount > 0 && (
            <Button size="sm" variant="secondary" onClick={rerunRedos} disabled={rerunning}>
              <RefreshCw className={`h-4 w-4 me-1 ${rerunning ? "animate-spin" : ""}`} />
              {t("studio.rerunRedos", { count: redoCount })}
            </Button>
          )}
          {rendered.length > 0 && <DownloadAllButton scriptId={scriptId} />}
          {rendered.length > 0 && (
            <Button size="sm" onClick={saveToDrive} disabled={archiving}>
              <FolderUp className="h-4 w-4 me-1" />
              {archiving ? t("studio.saving") : t("studio.saveToDrive")}
            </Button>
          )}
        </div>
      </div>

      {rendered.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        rendered.map((line) => {
          const req = line.resemble_request ?? {};
          const sentBody = (req.body as string | undefined) ?? line.tts_body ?? line.text_for_tts ?? "";
          const model = (req.model as string | undefined) ?? null;
          const expanded = expandedId === line.id;
          const lineTakes = takes[line.id] ?? [];
          return (
            <Card
              key={line.id}
              className={
                line.approved
                  ? "border-emerald-400"
                  : line.redo_requested
                    ? "border-amber-400"
                    : undefined
              }
            >
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                      <span>#{line.line_number} · {line.speaker_name}</span>
                      {line.output_duration_seconds ? (
                        <span>· {line.output_duration_seconds.toFixed(1)}s</span>
                      ) : null}
                      {line.emotion && line.emotion !== "neutral" && (
                        <span className="inline-flex items-center gap-1">
                          · {line.emotion}
                          <SourceBadge source={line.emotion_source} t={t} />
                        </span>
                      )}
                      {line.approved && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">
                          <BadgeCheck className="h-3 w-3" />
                          {t("studio.approved")}
                        </span>
                      )}
                      {line.redo_requested && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                          {t("studio.needsRedo")}
                        </span>
                      )}
                    </div>
                    <div className="text-sm truncate" dir="rtl">{line.text_clean}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={line.approved ? t("studio.unapprove") : t("studio.approve")}
                      className={line.approved ? "text-emerald-600" : undefined}
                      onClick={() => toggleApprove(line)}
                    >
                      <BadgeCheck className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.takes")}
                      onClick={() => toggleTakes(line.id)}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.settings")}
                      onClick={() => setExpandedId(expanded ? null : line.id)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.markRedo")}
                      onClick={() => openEdit(line)}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => downloadOne(line)}
                      title={t("studio.download")}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      onClick={() => playOne(line)}
                      disabled={playingId === line.id || playingAll}
                      title={t("studio.play")}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Settings transparency — exactly what was sent to Resemble. */}
                {expanded && (
                  <div className="rounded-md bg-muted/50 p-2 text-xs space-y-1.5" dir="rtl">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                      {model && <span>{t("studio.model")}: <code className="text-foreground">{model}</code></span>}
                      {req.sample_rate ? <span>{t("studio.sampleRate")}: {String(req.sample_rate)}</span> : null}
                      {req.mode ? <span>{t("studio.mode")}: {String(req.mode)}</span> : null}
                    </div>
                    {(line.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground">{t("studio.tags")}:</span>
                        {(line.tags ?? []).map((tag, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded bg-background border px-1.5 py-0.5">
                            <code>{tag.tag}</code>
                            <SourceBadge source={tag.source} t={t} />
                          </span>
                        ))}
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">{t("studio.sentBody")}:</span>
                      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background border p-2 text-foreground" dir="rtl">{sentBody}</pre>
                    </div>
                  </div>
                )}

                {/* Edit & send-again panel. */}
                {redoOpenId === line.id && (
                  <div className="rounded-md border p-2 space-y-2" dir="rtl">
                    <label className="text-xs font-medium">{t("studio.editText")}</label>
                    <Textarea
                      ref={editRef}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      dir="auto"
                    />
                    <p className="text-xs text-muted-foreground">{t("studio.editHint")}</p>

                    {/* Phonetic-spelling suggestions for a tricky word. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={suggestWord}
                        onChange={(e) => setSuggestWord(e.target.value)}
                        placeholder={t("studio.suggestWordPlaceholder")}
                        className="h-8 max-w-[16rem]"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={suggestForLine}
                        disabled={suggesting || !suggestWord.trim()}
                      >
                        <Sparkles className={`h-4 w-4 me-1 ${suggesting ? "animate-pulse" : ""}`} />
                        {t("studio.suggest")}
                      </Button>
                    </div>
                    {suggestions && (
                      <div className="space-y-1.5 rounded-md bg-muted/40 p-2 text-xs">
                        {suggestions.hebrew.length === 0 && suggestions.latin.length === 0 && (
                          <span className="text-muted-foreground">{t("studio.noSuggestions")}</span>
                        )}
                        {suggestions.hebrew.length > 0 && (
                          <SuggestChips label={t("studio.suggestHebrew")} items={suggestions.hebrew} onPick={insertSuggestion} />
                        )}
                        {suggestions.latin.length > 0 && (
                          <SuggestChips label={t("studio.suggestLatin")} items={suggestions.latin} onPick={insertSuggestion} />
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => regenerateNow(line)} disabled={regenLineId === line.id}>
                        <RefreshCw className={`h-4 w-4 me-1 ${regenLineId === line.id ? "animate-spin" : ""}`} />
                        {regenLineId === line.id ? t("studio.regenerating") : t("studio.regenerateNow")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => markRedo(line)}>
                        {t("studio.markRedo")}
                      </Button>
                      {line.redo_requested && (
                        <Button size="sm" variant="ghost" onClick={() => clearRedo(line.id)}>
                          <X className="h-4 w-4 me-1" /> {t("studio.clearRedo")}
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setRedoOpenId(null)}>
                        {t("studio.cancel")}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Take history. */}
                {takesOpenId === line.id && (
                  <div className="rounded-md border p-2 space-y-1.5 text-xs" dir="rtl">
                    {lineTakes.length === 0 ? (
                      <span className="text-muted-foreground">{t("studio.noTakes")}</span>
                    ) : (
                      lineTakes.map((take, idx) => (
                        <div key={take.id} className="flex items-center justify-between gap-2 rounded bg-muted/40 p-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-muted-foreground">
                              {t("studio.takeLabel", { n: lineTakes.length - idx })}
                              {" · "}
                              {new Date(take.created_at).toLocaleString(locale)}
                              {take.duration_seconds ? ` · ${take.duration_seconds.toFixed(1)}s` : ""}
                            </div>
                            {take.text_used && (
                              <div className="truncate" dir="auto">{take.text_used}</div>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button size="icon" variant="ghost" onClick={() => downloadTake(take, line.line_number, lineTakes.length - idx)} title={t("studio.download")}>
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => playTake(take)}
                              disabled={playingId === take.id || playingAll}
                              title={t("studio.play")}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
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
          className="inline-flex items-center rounded-full border bg-background px-2 py-0.5 hover:bg-accent"
          dir="auto"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function SourceBadge({
  source,
  t,
}: {
  source?: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!source || source === "none") return null;
  const isScript = source === "script";
  return (
    <span
      className={`rounded px-1 py-0.5 text-[10px] ${
        isScript ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
      }`}
    >
      {isScript ? t("studio.sourceScript") : t("studio.sourceLlm")}
    </span>
  );
}
