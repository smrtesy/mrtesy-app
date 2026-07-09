"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings2,
  FolderUp,
  Download,
  Sparkles,
  BadgeCheck,
  History,
  Loader2,
  Archive,
  Trash2,
  CheckSquare,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

import { DownloadAllButton } from "./DownloadAllButton";
import { noteSuffix } from "./takeName";

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
  take_count?: number;
  approved_take_count?: number;
  archived_at?: string | null;
}

interface Take {
  id: string;
  text_used: string | null;
  model: string | null;
  output_audio_path: string;
  duration_seconds: number | null;
  cost_usd: number | null;
  approved: boolean;
  note: string | null;
  created_at: string;
}

/** Pull the tone tags out of the exact body sent (works for old takes too):
 *  wrapping <build-intensity>… and inline [sigh]. */
function tagsFromBody(body: string | null): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const m of body.matchAll(/<([a-z][a-z-]*)>/gi)) found.add(m[1]);
  for (const m of body.matchAll(/\[([a-z][a-z-]*)\]/gi)) found.add(m[1]);
  return [...found];
}

interface Suggestions {
  hebrew: string[];
  latin: string[];
}

/** The body last sent to Resemble — what the edit box is prefilled with. */
function sentBodyOf(line: Line): string {
  const req = line.resemble_request ?? {};
  return ((req.body as string | undefined) ?? line.tts_body ?? line.text_for_tts ?? line.text_clean ?? "").trim();
}

export function AudioLineList({ scriptId }: { scriptId: string }) {
  const t = useTranslations("smrtVoice");
  const locale = useLocale();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [paused, setPaused] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // Line numbers from the most recent re-run, so the user can "play the new ones".
  const [newLineNumbers, setNewLineNumbers] = useState<number[]>([]);

  // Bulk archive/delete selection mode + archived-lines view.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Combined settings + edit + send-again panel (one per line).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [reanalyze, setReanalyze] = useState(false);
  const [regenLineId, setRegenLineId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  // The body the panel opened with, to detect an actual edit.
  const origBodyRef = useRef<string>("");
  // Live text selection inside the edit box, so "suggest" targets the picked
  // word and clicking a suggestion replaces exactly that word.
  const selRef = useRef<{ start: number; end: number } | null>(null);

  // Take history state (per-line, lazy-loaded on expand).
  const [takesOpenId, setTakesOpenId] = useState<string | null>(null);
  const [takes, setTakes] = useState<Record<string, Take[]>>({});
  const takesOpenIdRef = useRef<string | null>(null);
  useEffect(() => {
    takesOpenIdRef.current = takesOpenId;
  }, [takesOpenId]);

  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const cancelRef = useRef(false);
  const resolveRef = useRef<(() => void) | null>(null);
  // Pause/resume: pausedRef gates the play-all loop even in the gap between
  // lines (where there's no <audio> to pause), so Pause is reliable there too.
  const pausedRef = useRef(false);
  const resumeWaitersRef = useRef<Array<() => void>>([]);

  // Resolves immediately unless paused; while paused, parks the caller until
  // resumePlayback()/stopPlayback() releases it.
  function waitWhilePaused(): Promise<void> {
    if (!pausedRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resumeWaitersRef.current.push(resolve);
    });
  }
  function pausePlayback() {
    pausedRef.current = true;
    setPaused(true);
    currentAudioRef.current?.pause(); // keeps currentTime → resume continues
  }
  function resumePlayback() {
    pausedRef.current = false;
    setPaused(false);
    currentAudioRef.current?.play().catch(() => {});
    const waiters = resumeWaitersRef.current;
    resumeWaitersRef.current = [];
    waiters.forEach((w) => w());
  }

  // Silence playback and release any parked loop when leaving the screen.
  // Ref-only (no setState) since the component is unmounting.
  useEffect(() => () => {
    cancelRef.current = true;
    pausedRef.current = false;
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    const waiters = resumeWaitersRef.current;
    resumeWaitersRef.current = [];
    waiters.forEach((w) => w());
  }, []);

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
          const openId = takesOpenIdRef.current;
          if (openId) loadTakes(openId);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchLines, loadTakes, scriptId]);

  // Archived lines are hidden from the normal view; the "Archived (N)" toggle
  // swaps `rendered` to show only them.
  const rendered = (lines ?? []).filter(
    (l) => l.output_audio_path && (showArchived ? l.archived_at : !l.archived_at),
  );
  const archivedCount = (lines ?? []).filter((l) => l.output_audio_path && l.archived_at).length;
  const redoCount = (lines ?? []).filter((l) => l.redo_requested && !l.archived_at).length;

  async function playUrl(url: string, id: string): Promise<void> {
    const audio = new Audio(url);
    await new Promise<void>((resolve) => {
      resolveRef.current = resolve;
      currentAudioRef.current = audio;
      setPlayingId(id);
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
    // Clip finished on its own — drop the ref so a Resume pressed in the gap
    // before the next clip doesn't replay this ended clip on top of it.
    if (currentAudioRef.current === audio) currentAudioRef.current = null;
  }

  // Play the line's "good" takes in sequence (one after another). When none are
  // marked good, the selection endpoint falls back to the line's current audio.
  async function playOne(line: Line): Promise<void> {
    try {
      const { items } = await api<{ items: { url: string }[] }>(
        `/api/voice/lines/${line.id}/selection`,
      );
      // NOTE: do NOT reset cancelRef here — the caller owns it (playSequence
      // sets it once for the whole run; the single Play button resets it before
      // calling). Resetting here would swallow a Pause pressed during the
      // between-line fetch gap of "play all".
      if (items.length === 0) return;
      setPlayingId(line.id);
      for (const it of items) {
        if (cancelRef.current) break;
        await waitWhilePaused();
        if (cancelRef.current) break;
        await playUrl(it.url, line.id);
      }
    } catch {
      /* skip a failed line and continue */
    } finally {
      resolveRef.current = null;
      setPlayingId(null);
    }
  }

  async function downloadBlob(url: string, filename: string) {
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

  // Download the line's "good" takes (each file named with its take number and
  // note); when none are marked good, downloads the line's single current audio.
  async function downloadOne(line: Line) {
    try {
      const { items } = await api<{
        items: { url: string; take_number: number | null; note: string | null }[];
      }>(`/api/voice/lines/${line.id}/selection`);
      if (items.length === 0) {
        toast.error(t("studio.noAudio"));
        return;
      }
      const base = `${String(line.line_number).padStart(3, "0")}_${line.speaker_name}`;
      for (const it of items) {
        const name =
          it.take_number != null
            ? `${base}_v${it.take_number}${noteSuffix(it.note)}.wav`
            : `${base}.wav`;
        await downloadBlob(it.url, name);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function playSequence(items: Line[]) {
    const playable = items.filter((l) => l.output_audio_path);
    if (playable.length === 0) return;
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setPlayingAll(true);
    for (const line of playable) {
      if (cancelRef.current) break;
      await waitWhilePaused();
      if (cancelRef.current) break;
      await playOne(line);
    }
    setPlayingAll(false);
    setPaused(false);
    pausedRef.current = false;
    currentAudioRef.current = null;
  }

  function stopPlayback() {
    cancelRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    // Release any loop parked in the between-lines gap so it sees the cancel.
    const waiters = resumeWaitersRef.current;
    resumeWaitersRef.current = [];
    waiters.forEach((w) => w());
    setPlayingAll(false);
    setPlayingId(null);
  }

  // Open/close the combined settings + edit panel. On open, prefill the edit
  // box with exactly what was last sent to Resemble.
  function toggleSettings(line: Line) {
    const next = expandedId === line.id ? null : line.id;
    setExpandedId(next);
    if (next) {
      const body = sentBodyOf(line);
      setEditText(body);
      origBodyRef.current = body;
      setReanalyze(false);
      setSuggestions(null);
      selRef.current = null;
    }
  }

  function captureSelection() {
    const el = editRef.current;
    if (!el) return;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    selRef.current = e > s ? { start: s, end: e } : null;
  }

  async function suggestForWord() {
    // Prefer the selected word; fall back to a single-token box.
    let query = "";
    if (selRef.current) {
      query = editText.slice(selRef.current.start, selRef.current.end).trim();
    }
    if (!query) {
      const whole = editText.trim();
      if (whole && !/\s/.test(whole) && whole.length <= 30) {
        query = whole;
        selRef.current = null;
      }
    }
    if (!query) {
      toast(t("studio.selectWordHint"));
      return;
    }
    setSuggesting(true);
    try {
      const s = await api<Suggestions>("/api/voice/pronunciation/suggest", {
        method: "POST",
        body: { word: query },
      });
      setSuggestions(s);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSuggesting(false);
    }
  }

  // Replace the selected word with the chosen suggestion (or insert at caret).
  function applySuggestion(value: string) {
    const el = editRef.current;
    const sel = selRef.current;
    if (sel) {
      const next = editText.slice(0, sel.start) + value + editText.slice(sel.end);
      setEditText(next);
      const end = sel.start + value.length;
      selRef.current = { start: sel.start, end };
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(sel.start, end);
      });
      return;
    }
    const start = el?.selectionStart ?? editText.length;
    const endc = el?.selectionEnd ?? editText.length;
    const next = editText.slice(0, start) + value + editText.slice(endc);
    setEditText(next);
    const caret = start + value.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  // "Send again" for one line: edited text (verbatim) and/or re-analyze tone.
  async function regenerateNow(line: Line) {
    setRegenLineId(line.id);
    try {
      const edited = editText.trim();
      const changed = !!edited && edited !== origBodyRef.current.trim();
      const body: Record<string, unknown> = {};
      if (changed) body.text_for_tts = edited;
      if (reanalyze) body.reprocess = true;
      await api(`/api/voice/lines/${line.id}/regenerate`, { method: "POST", body });
      setNewLineNumbers([line.line_number]);
      setExpandedId(null);
      toast.success(t("studio.redoQueued", { count: 1 }));
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRegenLineId(null);
    }
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

  // `n` is the human take number shown on screen (newest = highest), so the
  // downloaded filename matches the "Take N" label the user clicked.
  async function downloadTake(take: Take, lineNumber: number, n: number) {
    try {
      const { audio_url } = await api<{ audio_url: string }>(
        `/api/voice/takes/${take.id}/audio-url`,
      );
      await downloadBlob(audio_url, `${String(lineNumber).padStart(3, "0")}_take${n}${noteSuffix(take.note)}.wav`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    }
  }

  // Toggle whether this take is marked "good" (⭐). Multi-select: several takes
  // can be good on one line (e.g. to take part of each in editing). Independent
  // of what the engine renders — marking never changes the produced file, so a
  // regenerate can't steal the selection. The line's play/download/archive and
  // outer indicator all follow the set of good takes.
  async function toggleGood(take: Take) {
    const next = !take.approved;
    setTakes((prev) => {
      const key = takesOpenId ?? "";
      const list = (prev[key] ?? []).map((tk) =>
        tk.id === take.id ? { ...tk, approved: next } : tk,
      );
      return takesOpenId ? { ...prev, [key]: list } : prev;
    });
    try {
      await api(`/api/voice/takes/${take.id}`, { method: "PATCH", body: { approved: next } });
      fetchLines(); // refresh approved_take_count → outer indicator
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
      if (takesOpenId) loadTakes(takesOpenId);
    }
  }

  async function patchTake(take: Take, body: Record<string, unknown>) {
    // Optimistically update the open take list, then persist.
    setTakes((prev) => {
      const list = prev[takesOpenId ?? ""] ?? [];
      const next = list.map((tk) => (tk.id === take.id ? { ...tk, ...body } : tk));
      return takesOpenId ? { ...prev, [takesOpenId]: next } : prev;
    });
    try {
      await api(`/api/voice/takes/${take.id}`, { method: "PATCH", body });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
      if (takesOpenId) loadTakes(takesOpenId); // reload to undo the optimistic change
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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelect() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  // Archive (soft, reversible), unarchive, or permanently delete the selected
  // lines. Delete cascades to the lines' takes and removes their audio.
  async function bulkAction(action: "archive" | "unarchive" | "delete") {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (action === "delete" && !window.confirm(t("studio.confirmDeleteLines", { count: ids.length }))) {
      return;
    }
    setBulkBusy(true);
    try {
      await api(`/api/voice/scripts/${scriptId}/lines/bulk`, {
        method: "POST",
        body: { action, line_ids: ids },
      });
      exitSelect();
      fetchLines();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkBusy(false);
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (lines === null) return <p className="text-sm text-muted-foreground">…</p>;

  const newOnes = rendered.filter(
    (l) => newLineNumbers.includes(l.line_number) && l.status === "completed",
  );

  return (
    <div className="space-y-3">
      {/* Header with quiet icon actions (compact by design). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("audio.title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {selectMode ? (
            <>
              <span className="text-sm text-muted-foreground">
                {t("studio.selectedCount", { count: selectedIds.size })}
              </span>
              {showArchived ? (
                <Button size="sm" variant="outline" disabled={bulkBusy || selectedIds.size === 0} onClick={() => bulkAction("unarchive")}>
                  <Archive className="h-4 w-4 me-1" /> {t("studio.unarchive")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={bulkBusy || selectedIds.size === 0} onClick={() => bulkAction("archive")}>
                  <Archive className="h-4 w-4 me-1" /> {t("studio.archiveAction")}
                </Button>
              )}
              <Button size="sm" variant="destructive" disabled={bulkBusy || selectedIds.size === 0} onClick={() => bulkAction("delete")}>
                <Trash2 className="h-4 w-4 me-1" /> {t("studio.deleteAction")}
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelect}>{t("studio.cancel")}</Button>
            </>
          ) : (
            <>
              {rendered.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => setSelectMode(true)}>
                  <CheckSquare className="h-4 w-4 me-1" /> {t("studio.select")}
                </Button>
              )}
              {showArchived ? (
                <Button size="sm" variant="outline" onClick={() => setShowArchived(false)}>
                  {t("studio.backFromArchived")}
                </Button>
              ) : (
                archivedCount > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setShowArchived(true)}>
                    <Archive className="h-4 w-4 me-1" /> {t("studio.archivedView", { count: archivedCount })}
                  </Button>
                )
              )}
              {!showArchived && rendered.length > 0 &&
                (playingAll ? (
                  <div className="inline-flex overflow-hidden rounded-md border">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-none border-e"
                      onClick={paused ? resumePlayback : pausePlayback}
                      title={paused ? t("studio.resume") : t("studio.pause")}
                    >
                      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-none"
                      onClick={stopPlayback}
                      title={t("studio.stop")}
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => playSequence(rendered)}>
                    <Play className="h-4 w-4 me-1" /> {t("studio.playAll")}
                  </Button>
                ))}
              {!showArchived && newOnes.length > 0 && !playingAll && (
                <Button size="sm" variant="outline" onClick={() => playSequence(newOnes)}>
                  <Play className="h-4 w-4 me-1" /> {t("studio.playNew", { count: newOnes.length })}
                </Button>
              )}
              {!showArchived && redoCount > 0 && (
                <Button size="sm" variant="secondary" onClick={rerunRedos} disabled={rerunning}>
                  <RefreshCw className={`h-4 w-4 me-1 ${rerunning ? "animate-spin" : ""}`} />
                  {t("studio.rerunRedos", { count: redoCount })}
                </Button>
              )}
              {!showArchived && rendered.length > 0 && <DownloadAllButton scriptId={scriptId} />}
              {!showArchived && rendered.length > 0 && (
                <Button size="sm" onClick={saveToDrive} disabled={archiving}>
                  <FolderUp className="h-4 w-4 me-1" />
                  {archiving ? t("studio.saving") : t("studio.saveToDrive")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {rendered.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        rendered.map((line) => {
          const req = line.resemble_request ?? {};
          const model = (req.model as string | undefined) ?? null;
          const expanded = expandedId === line.id;
          const lineTakes = takes[line.id] ?? [];
          const takeCount = line.take_count ?? 0;
          const goodCount = line.approved_take_count ?? 0;
          const regenerating = line.status === "processing";
          return (
            <Card
              key={line.id}
              className={
                goodCount > 0
                  ? "border-emerald-400"
                  : line.redo_requested
                    ? "border-amber-400"
                    : undefined
              }
            >
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  {selectMode && (
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0"
                      checked={selectedIds.has(line.id)}
                      onChange={() => toggleSelect(line.id)}
                      aria-label={t("studio.select")}
                    />
                  )}
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    role="button"
                    tabIndex={0}
                    title={selectMode ? undefined : t("studio.takes")}
                    onClick={() => (selectMode ? toggleSelect(line.id) : toggleTakes(line.id))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (selectMode) toggleSelect(line.id);
                        else toggleTakes(line.id);
                      }
                    }}
                  >
                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                      <span>#{line.line_number} · {line.speaker_name}</span>
                      {line.archived_at && (
                        <span className="rounded bg-muted px-1.5 py-0.5">{t("studio.archivedBadge")}</span>
                      )}
                      {line.output_duration_seconds ? (
                        <span>· {line.output_duration_seconds.toFixed(1)}s</span>
                      ) : null}
                      {line.emotion && line.emotion !== "neutral" && (
                        <span className="inline-flex items-center gap-1">
                          · {line.emotion}
                          <SourceBadge source={line.emotion_source} t={t} />
                        </span>
                      )}
                      {regenerating && (
                        <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-blue-800">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("studio.recreating")}
                        </span>
                      )}
                      {goodCount > 0 && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">
                          <BadgeCheck className="h-3 w-3" />
                          {t("studio.goodCount", { count: goodCount })}
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
                  {!selectMode && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.takes")}
                      className="relative"
                      onClick={() => toggleTakes(line.id)}
                    >
                      <History className="h-4 w-4" />
                      {takeCount > 0 && (
                        <span className="absolute -top-1 -end-1 min-w-[16px] rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
                          {takeCount}
                        </span>
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t("studio.settings")}
                      onClick={() => toggleSettings(line)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => downloadOne(line)}
                      title={t("studio.download")}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    {playingId === line.id ? (
                      // Currently playing (single or as part of "play all") —
                      // show a pause control so it's clear which line is live.
                      <Button size="icon" onClick={stopPlayback} title={t("studio.pause")}>
                        <Pause className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        onClick={() => {
                          cancelRef.current = false;
                          playOne(line);
                        }}
                        disabled={playingAll}
                        title={t("studio.play")}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  )}
                </div>

                {/* Combined transparency + edit + send-again panel. */}
                {expanded && (
                  <div className="rounded-md bg-muted/50 p-2 text-xs space-y-2" dir="rtl">
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

                    {/* Editable body (what gets sent to Resemble). */}
                    <div className="space-y-1">
                      <label className="font-medium">{t("studio.sentBody")}</label>
                      <Textarea
                        ref={editRef}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onSelect={captureSelection}
                        rows={3}
                        dir="auto"
                        className="text-sm"
                      />
                      <p className="text-muted-foreground">{t("studio.editHint")}</p>
                    </div>

                    {/* Word-level phonetic suggestions. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={suggestForWord} disabled={suggesting}>
                        <Sparkles className={`h-4 w-4 me-1 ${suggesting ? "animate-pulse" : ""}`} />
                        {t("studio.suggest")}
                      </Button>
                      <span className="text-muted-foreground">{t("studio.selectWordHint")}</span>
                    </div>
                    {suggestions && (
                      <div className="space-y-1.5 rounded-md bg-background/60 p-2">
                        {suggestions.hebrew.length === 0 && suggestions.latin.length === 0 && (
                          <span className="text-muted-foreground">{t("studio.noSuggestions")}</span>
                        )}
                        {suggestions.hebrew.length > 0 && (
                          <SuggestChips label={t("studio.suggestHebrew")} items={suggestions.hebrew} onPick={applySuggestion} />
                        )}
                        {suggestions.latin.length > 0 && (
                          <SuggestChips label={t("studio.suggestLatin")} items={suggestions.latin} onPick={applySuggestion} />
                        )}
                      </div>
                    )}

                    {/* Re-analyze tone: re-run the LLM for fresh emotion + tags. */}
                    <label className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={reanalyze}
                        onChange={(e) => setReanalyze(e.target.checked)}
                      />
                      <span className="font-medium">{t("studio.reanalyzeTone")}</span>
                      <span className="text-muted-foreground">({t("studio.reanalyzeHint")})</span>
                    </label>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" onClick={() => regenerateNow(line)} disabled={regenLineId === line.id || regenerating}>
                        <RefreshCw className={`h-4 w-4 me-1 ${regenLineId === line.id ? "animate-spin" : ""}`} />
                        {regenLineId === line.id ? t("studio.regenerating") : t("studio.regenerateNow")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setExpandedId(null)}>
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
                      lineTakes.map((take, idx) => {
                        const takeTags = tagsFromBody(take.text_used);
                        return (
                        <div
                          key={take.id}
                          className={`rounded p-1.5 space-y-1 ${take.approved ? "bg-emerald-50 ring-1 ring-emerald-300" : "bg-muted/40"}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                                <span>{t("studio.takeLabel", { n: lineTakes.length - idx })}</span>
                                {take.approved && (
                                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">{t("studio.good")}</span>
                                )}
                                <span>· {new Date(take.created_at).toLocaleString(locale)}</span>
                                {take.duration_seconds ? <span>· {take.duration_seconds.toFixed(1)}s</span> : null}
                                {takeTags.map((tg) => (
                                  <code key={tg} className="rounded bg-background border px-1 py-0.5">{tg}</code>
                                ))}
                              </div>
                              {take.text_used && (
                                <div className="truncate" dir="auto">{take.text_used}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                title={take.approved ? t("studio.unmarkGood") : t("studio.markGood")}
                                className={take.approved ? "text-emerald-600" : undefined}
                                onClick={() => toggleGood(take)}
                              >
                                <BadgeCheck className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => downloadTake(take, line.line_number, lineTakes.length - idx)} title={t("studio.download")}>
                                <Download className="h-4 w-4" />
                              </Button>
                              {playingId === take.id ? (
                                <Button size="icon" variant="ghost" onClick={stopPlayback} title={t("studio.pause")}>
                                  <Pause className="h-4 w-4" />
                                </Button>
                              ) : (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => playTake(take)}
                                  disabled={playingAll}
                                  title={t("studio.play")}
                                >
                                  <Play className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                          {/* Per-take note: which word to keep from this take. */}
                          <input
                            type="text"
                            defaultValue={take.note ?? ""}
                            placeholder={t("studio.takeNotePlaceholder")}
                            dir="auto"
                            className="w-full rounded border bg-background px-2 py-1 text-xs"
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v !== (take.note ?? "")) patchTake(take, { note: v || null });
                            }}
                          />
                        </div>
                        );
                      })
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
