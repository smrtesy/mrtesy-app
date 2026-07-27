"use client";

/**
 * Hebrew dictation with a silence stop — "אני מדבר, עוצר ל-3 שניות, הוא כותב ושולח".
 *
 * Press once and talk. The button watches the microphone's level and, three
 * seconds after you stop talking, ends the recording by itself, transcribes it,
 * and hands the text to the parent — which is what turns dictation into
 * speak-and-it-happens instead of press-talk-press-send.
 *
 * WHY LEVEL DETECTION AND NOT A FIXED TIMER: a fixed timer would cut you off
 * mid-sentence. The analyser tracks a noise floor and treats "quiet" as relative
 * to the room, so a noisy room doesn't hold the recording open forever and a quiet
 * one doesn't end it between words.
 *
 * ⚠️ COST: transcription is a paid Gemini call, one per press (the same endpoint
 * and prompt the WhatsApp composer uses). The screen states this next to the
 * button; nothing here retries or batches.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Mic, Square, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/** Quiet for this long after speech has been heard ends the recording. */
const SILENCE_MS = 3000;
/** How often the level is sampled. 100ms is fine-grained enough for a 3s window
 *  and cheap enough to run on a phone. */
const SAMPLE_MS = 100;
/** Absolute floor, so a muted or dead microphone can never read as speech. */
const MIN_SPEECH_LEVEL = 0.02;
/** Speech has to stand this far above the measured room noise. */
const NOISE_MULTIPLIER = 2.5;
/** Hard cap on one dictation, so a forgotten open mic can't upload an hour. */
const MAX_MS = 120_000;

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on anything
  // longer than a few seconds of audio.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function DictationButton({
  onText,
  disabled,
  className,
}: {
  /** Receives the transcript. The caller decides what to do with it (the Claude
   *  screen appends it to the prompt and may launch immediately). */
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("claudeRuns.dictation");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Seconds of silence counted so far, surfaced so the auto-stop is visible
   *  rather than something that just happens. */
  const [quiet, setQuiet] = useState(0);

  /** Held in a ref because the transcript is delivered from `mr.onstop`, a closure
   *  created when the mic was pressed. Calling the captured `onText` would use the
   *  caller's state from THAT render — so anything the user picked or typed while
   *  recording (a working method, a repo, more prompt text) would be ignored. */
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** True once the user has actually said something. Until then silence must not
   *  end the recording — otherwise it would stop before the first word. */
  const heardSpeechRef = useRef(false);
  /** Set when the recording is aborted, so onstop skips the paid transcription. */
  const cancelledRef = useRef(false);

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setQuiet(0);
  }, []);

  // Releasing the microphone on unmount is not optional: the browser keeps the
  // recording indicator (and the track) alive otherwise.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      const mr = recorderRef.current;
      if (mr && mr.state !== "inactive") mr.stop();
      recorderRef.current = null;
      teardown();
    };
  }, [teardown]);

  const stop = useCallback(() => {
    const mr = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (mr && mr.state !== "inactive") mr.stop();
    else teardown();
  }, [teardown]);

  async function transcribe(blob: Blob) {
    setBusy(true);
    try {
      const { text } = await api<{ text: string }>("/api/claude/transcribe", {
        method: "POST",
        body: { audio_base64: await blobToBase64(blob), mime_type: blob.type },
      });
      const cleaned = (text ?? "").trim();
      if (!cleaned) {
        toast.error(t("empty"));
        return;
      }
      onTextRef.current(cleaned);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (recording || busy) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t("unsupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      heardSpeechRef.current = false;
      cancelledRef.current = false;

      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        teardown();
        // Deliberately NOT gated on heardSpeechRef: the analyser is only how the
        // auto-stop is timed, and when it is unavailable or suspended it reports
        // silence for real speech. Gating transcription on it turned that into
        // "press, speak, stop, nothing happens" with no error at all. An aborted
        // recording still never spends money, and an empty blob has nothing to send.
        if (!cancelledRef.current && blob.size > 0) void transcribe(blob);
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);

      // ── silence watcher ──
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        // No analyser available: the recording still works, it just has to be
        // stopped by hand. Better than refusing to record at all.
        toast.message(t("noAutoStop"));
        return;
      }
      const ctx = new AudioCtor();
      audioCtxRef.current = ctx;
      // The context is created after `await getUserMedia`, so it is no longer inside
      // the click gesture and browsers (iOS Safari, autoplay policy) can start it
      // suspended. A suspended context feeds the analyser pure silence — the
      // auto-stop would never fire. Same fix as WhatsApp's voice meter.
      void ctx.resume?.();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);

      const startedAt = Date.now();
      let lastLoudAt = Date.now();
      let noiseFloor = MIN_SPEECH_LEVEL;

      timerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        // Mean absolute deviation from the 128 midpoint, normalised to 0..1.
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += Math.abs(data[i] - 128);
        const level = sum / data.length / 128;

        const threshold = Math.max(MIN_SPEECH_LEVEL, noiseFloor * NOISE_MULTIPLIER);
        if (level > threshold) {
          heardSpeechRef.current = true;
          lastLoudAt = Date.now();
          setQuiet(0);
        } else {
          // Track the room while it is quiet only — adapting during speech would
          // drag the threshold up and make the speaker look like silence.
          noiseFloor = noiseFloor * 0.9 + level * 0.1;
          const quietMs = Date.now() - lastLoudAt;
          if (heardSpeechRef.current) setQuiet(Math.min(SILENCE_MS, quietMs));
          if (heardSpeechRef.current && quietMs >= SILENCE_MS) {
            stop();
            return;
          }
        }

        if (Date.now() - startedAt >= MAX_MS) {
          toast.message(t("maxLength"));
          stop();
        }
      }, SAMPLE_MS);
    } catch (e) {
      teardown();
      setRecording(false);
      toast.error(e instanceof Error ? e.message : t("permission"));
    }
  }

  const label = busy ? t("transcribing") : recording ? t("stop") : t("start");
  // Whole seconds remaining until the auto-stop, so the countdown reads 3·2·1.
  const remaining = recording && quiet > 0 ? Math.ceil((SILENCE_MS - quiet) / 1000) : null;

  return (
    <Button
      type="button"
      size="sm"
      variant={recording ? "destructive" : "outline"}
      disabled={disabled || busy}
      onClick={() => (recording ? stop() : void start())}
      aria-label={label}
      title={label}
      aria-pressed={recording}
      className={cn("gap-1.5", className)}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : recording ? (
        <Square className="size-4" />
      ) : (
        <Mic className="size-4" />
      )}
      <span>{label}</span>
      {remaining !== null && <span className="tabular-nums text-xs opacity-80">{remaining}</span>}
    </Button>
  );
}
