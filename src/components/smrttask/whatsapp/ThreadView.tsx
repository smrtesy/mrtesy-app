"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, Check, CheckCheck, AlertCircle, Loader2, FileText, Download, Send, SmilePlus, CheckSquare, Mic, MicOff, Sparkles, X, ScanText, Pencil, Reply, ImagePlus, Clock, Search, ChevronUp, ChevronDown, AudioLines, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import type { Thread } from "./ThreadList";
import { detectMessageDir } from "./utils";
import { RichMessageText } from "./RichMessageText";

export interface Message {
  id: string;
  wamid: string;
  chat_id: string;
  direction: "incoming" | "outgoing";
  from_phone: string;
  from_name: string | null;
  to_phone: string | null;
  message_type: string;
  body_text: string | null;
  media_id: string | null;
  media_mime: string | null;
  media_url: string | null;
  media_filename: string | null;
  media_size: number | null;
  /** Verbatim image OCR / visual description. Rendered in a separate framed
   *  block (distinct from the user-typed caption in body_text). */
  media_ocr_text?: string | null;
  /** Verbatim audio transcript. Same separation treatment as media_ocr_text. */
  audio_transcript?: string | null;
  /** Short-lived signed URL for media_url, batch-minted by the messages
   *  endpoint (one Storage call per response). When present, the bubble uses
   *  it directly instead of a per-bubble /api/whatsapp/media round-trip;
   *  null/absent falls back to that endpoint (legacy rows, sign failures). */
  media_signed_url?: string | null;
  reply_to_wamid: string | null;
  reaction_emoji: string | null;
  is_reaction: boolean;
  is_history: boolean;
  history_phase: number | null;
  received_at: string;
  /** Last-modified time, bumped by a DB trigger on every update (status
   *  flips, reaction clears, transcript/OCR fills). Drives the reader's
   *  incremental poll cursor. Optional: absent on optimistic client rows
   *  (and on servers deployed before the updated_at migration). */
  updated_at?: string | null;
  // Read/delivery receipts — only populated for outgoing messages once
  // Meta sends us the corresponding `statuses` webhook event.
  status?: "sent" | "delivered" | "read" | "failed" | null;
  status_error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  /** Client-only: an optimistic bubble rendered immediately on send, before
   *  Meta confirms. Shows a clock ⏱️ until the real message arrives. */
  pending?: boolean;
}

export interface ChatTask {
  id: string;
  title: string | null;
  title_he: string | null;
  status: string | null;
  priority: string | null;
  /** false = still a pending AI suggestion (lives in /inbox);
   *  true = user-approved task (lives in /tasks). */
  manually_verified: boolean | null;
  created_at: string;
  due_date: string | null;
  /** When the task was created from a per-message source_message
   *  (source_type='whatsapp_echo'), this is the exact wamid it came from.
   *  Prefer this over the time-based heuristic — it's a precise link. */
  source_wamid?: string | null;
}

interface Props {
  messages: Message[];
  /** Tasks created from this chat (across the whole conversation history),
   *  passed through from the parent so we can render a per-message badge
   *  next to the message that most likely produced each task. */
  tasks: ChatTask[];
  loading: boolean;
  chatId: string;
  thread: Thread | undefined;
  locale: string;
  onBack: () => void;
  /** Force the "back to chat list" button to always show (not just on mobile).
   *  Used by the docked side-panel, which is single-pane at every width and
   *  otherwise has no way to return to the thread list on desktop. */
  alwaysShowBack?: boolean;
  /** Called after a successful send so the parent can refetch immediately. */
  onMessageSent?: () => void;
  /** One-shot draft to prefill the composer (e.g. from a smrtTask "reply in
   *  WhatsApp" action surfaced in the side-panel, where there's no ?draft= URL). */
  initialDraft?: string | null;
  /** One-shot wamid to scroll-to + briefly highlight once messages load — set
   *  when the user opens this chat from a task's WhatsApp source badge, so we
   *  land on the exact source message instead of just the bottom of the chat. */
  focusWamid?: string | null;
  /** Called after the user renames the contact so the parent can refresh
   *  the thread list (so the new name appears in the left pane too). */
  onContactRenamed?: () => void;
}

const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

// Stable empty fallbacks for per-bubble props. Inline `?? []` would hand the
// memoized MessageBubble a fresh array identity on every render, defeating
// React.memo for the (common) bubbles with no reactions / no linked tasks.
const EMPTY_REACTIONS: Array<{ emoji: string; direction: string }> = [];
const EMPTY_TASKS: ChatTask[] = [];

// Outgoing-image limits, mirroring the backend (Meta accepts JPEG/PNG up to
// 5 MB for the `image` message type). We validate client-side too so a bad
// paste/drop is rejected instantly with a clear toast instead of a round-trip.
const IMAGE_ALLOWED_MIME = ["image/jpeg", "image/png"];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_COUNT = 10;

/** A locally-staged image waiting to be sent. `url` is an object URL for the
 *  preview thumbnail and must be revoked when the image is removed/cleared. */
interface PendingImage {
  id: string;
  file: File;
  url: string;
}

/** Max voice-note duration. Keeps the base64 upload under the server's 10 MB
 *  JSON body cap and matches a sensible WhatsApp-note length. On reaching it
 *  the recording stops and sends automatically. */
const VOICE_NOTE_MAX_SECONDS = 5 * 60;

/** Browser-safe base64 of a Blob's bytes, chunked to avoid a call-stack
 *  overflow on long recordings. Shared by the dictation + voice-note paths. */
async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(arrayBuf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Seconds → "m:ss" for the recording timer. */
function fmtDuration(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Live mic-level waveform for the voice-note recording bar — the WhatsApp-Web
 * cue that tells you it's actually picking up your voice. Taps the recording
 * MediaStream with a Web Audio AnalyserNode and paints a scrolling bar meter
 * (newest sample on the right) on a canvas via requestAnimationFrame. Owns its
 * own AudioContext and tears everything down on unmount, so it never leaks an
 * audio graph across recordings. Colour follows the element's CSS `color`, so
 * it themes itself (we render it in the recording accent colour).
 */
const WAVEFORM_BARS = 48;
function RecordingWaveform({ stream }: { stream: MediaStream }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    // Autoplay policies can leave the context suspended until a gesture; the
    // mic tap is one, but resume() defensively so the meter always animates.
    void audioCtx.resume?.();

    const data = new Uint8Array(analyser.frequencyBinCount);
    const levels = new Array(WAVEFORM_BARS).fill(0);
    const canvas = canvasRef.current;
    const cctx = canvas?.getContext("2d") ?? null;
    const color = canvas ? getComputedStyle(canvas).color : "#888";
    const hasRoundRect = typeof cctx?.roundRect === "function";
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!canvas || !cctx) return;
      // RMS of the time-domain signal → a 0..1 loudness for this frame.
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Scroll the history left and append the new level (clamped, scaled up a
      // touch so normal speech fills a satisfying portion of the meter).
      levels.push(Math.min(1, rms * 2.6));
      levels.shift();

      const w = canvas.width;
      const h = canvas.height;
      cctx.clearRect(0, 0, w, h);
      cctx.fillStyle = color;
      const slot = w / WAVEFORM_BARS;
      const barW = Math.max(1.5, slot * 0.55);
      for (let i = 0; i < WAVEFORM_BARS; i++) {
        const bh = Math.max(2, levels[i] * h);
        const x = i * slot + (slot - barW) / 2;
        const y = (h - bh) / 2;
        if (hasRoundRect) {
          cctx.beginPath();
          cctx.roundRect(x, y, barW, bh, barW / 2);
          cctx.fill();
        } else {
          cctx.fillRect(x, y, barW, bh);
        }
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* graph already torn down */
      }
      void audioCtx.close().catch(() => {});
    };
  }, [stream]);

  return <canvas ref={canvasRef} width={300} height={36} className="h-7 w-full text-status-late" />;
}

/** Read a File into a base64 string (no data: prefix — the backend also strips
 *  one defensively, but we keep the payload clean). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function ThreadView({ messages, tasks, loading, chatId, thread, locale, onBack, alwaysShowBack, onMessageSent, onContactRenamed, initialDraft, focusWamid }: Props) {
  const t = useTranslations("whatsappPage");
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Optimistic send (WhatsApp-Web feel) ───────────────────────────────────
  // Outgoing text bubbles and reactions are rendered the instant the user
  // acts, before Meta confirms — so the conversation never feels like it's
  // waiting on the network. They're reconciled against the real rows the next
  // poll/refetch brings in.
  //
  // `pendingMessages`: optimistic outgoing text bubbles. Each starts with a
  // temp wamid; on send success we swap in the real wamid so it dedupes
  // against the server row (which shares it) and the optimistic copy drops.
  const [pendingMessages, setPendingMessages] = useState<Message[]>([]);
  // `optimisticReactions`: target_wamid → emoji ("" = removed). Overlaid on the
  // reactions derived from messages so a tapped emoji shows immediately.
  const [optimisticReactions, setOptimisticReactions] = useState<Record<string, string>>({});

  const realWamids = useMemo(() => new Set(messages.map((m) => m.wamid)), [messages]);
  // Visible stream = server messages + any optimistic bubble whose real row
  // hasn't landed yet (appended last → newest, at the bottom).
  const mergedMessages = useMemo(() => {
    const extra = pendingMessages.filter((m) => !realWamids.has(m.wamid));
    return extra.length ? [...messages, ...extra] : messages;
  }, [messages, pendingMessages, realWamids]);

  // Drop optimistic bubbles once their real row arrives (state cleanup; the
  // merge above already hides them visually).
  useEffect(() => {
    setPendingMessages((curr) => {
      if (curr.length === 0) return curr;
      const next = curr.filter((m) => !realWamids.has(m.wamid));
      return next.length === curr.length ? curr : next;
    });
  }, [realWamids]);

  // Drop optimistic reaction overrides once the real outgoing reaction agrees.
  useEffect(() => {
    setOptimisticReactions((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const target of keys) {
        let real = "";
        for (const mm of messages) {
          if (mm.is_reaction && mm.reply_to_wamid === target && mm.direction === "outgoing") {
            real = mm.reaction_emoji ?? "";
          }
        }
        if (real === prev[target]) {
          delete next[target];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [messages]);

  // Clear all optimistic state when switching conversations.
  useEffect(() => {
    setPendingMessages([]);
    setOptimisticReactions({});
  }, [chatId]);

  // Add an optimistic outgoing text bubble; returns its temp id so the caller
  // can resolve (real wamid) or remove (failure) it.
  const addPendingText = useCallback(
    (body: string, replyToWamid: string | null) => {
      const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const msg: Message = {
        id,
        wamid: id,
        chat_id: chatId,
        direction: "outgoing",
        from_phone: "",
        from_name: null,
        to_phone: chatId,
        message_type: "text",
        body_text: body,
        media_id: null,
        media_mime: null,
        media_url: null,
        media_filename: null,
        media_size: null,
        reply_to_wamid: replyToWamid,
        reaction_emoji: null,
        is_reaction: false,
        is_history: false,
        history_phase: null,
        received_at: new Date().toISOString(),
        status: null,
        pending: true,
      };
      setPendingMessages((c) => [...c, msg]);
      return id;
    },
    [chatId],
  );
  const resolvePendingText = useCallback((id: string, wamid: string) => {
    setPendingMessages((c) =>
      c.map((m) => (m.id === id ? { ...m, wamid, pending: false, status: "sent" } : m)),
    );
  }, []);
  const removePendingText = useCallback((id: string) => {
    setPendingMessages((c) => c.filter((m) => m.id !== id));
  }, []);

  // Jump to a specific source message (from a task's WhatsApp source badge).
  // The wamid we're asked to focus, and whether we've already handled it for
  // this value — one-shot per focus target so a background re-poll doesn't
  // keep yanking the scroll back. `highlightWamid` drives the transient ring.
  const [highlightWamid, setHighlightWamid] = useState<string | null>(null);
  const handledFocusRef = useRef<string | null>(null);
  // Whether we've already positioned the scroll for this chat (initial
  // bottom-snap or a focus jump). Gates the "snap to bottom" so it only fires
  // on first paint or when the user is already near the bottom.
  const positionedRef = useRef(false);

  // Auto-scroll on new messages, WhatsApp-style: jump to the bottom on first
  // paint, and afterwards only when the user is already near the bottom.
  // Anyone reading history further up (incl. someone who just jumped to a
  // source message) is left in place — a fresh message won't yank them away.
  useEffect(() => {
    // Nothing to position against yet — don't mark positioned on the empty
    // pre-load render, or the first real batch would skip the bottom-snap.
    if (mergedMessages.length === 0) return;
    // While a focus jump is still pending, let the focus effect own the scroll.
    if (focusWamid && handledFocusRef.current !== focusWamid) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!positionedRef.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    positionedRef.current = true;
  }, [mergedMessages.length, focusWamid]);

  // Reset per-chat scroll/focus bookkeeping when the conversation (or the
  // focus target) changes.
  useEffect(() => {
    handledFocusRef.current = null;
    positionedRef.current = false;
    setHighlightWamid(null);
  }, [chatId, focusWamid]);

  useEffect(() => {
    if (!focusWamid || handledFocusRef.current === focusWamid) return;
    const container = scrollRef.current;
    if (!container) return;
    // The message must be in the loaded window. If it isn't here yet (still
    // loading / outside the 200-message window), wait for the next render.
    const el = container.querySelector<HTMLElement>(
      `[data-wamid="${CSS.escape(focusWamid)}"]`,
    );
    if (!el) return;
    handledFocusRef.current = focusWamid;
    // Mark positioned so the bottom-snap effect treats this jump as the
    // initial position and doesn't immediately pull back to the bottom.
    positionedRef.current = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightWamid(focusWamid);
  }, [focusWamid, messages]);
  // Auto-clear the highlight ring on its own timer. Kept separate from the
  // scroll effect so a background message re-poll (which changes `messages`)
  // can't cancel the timer and leave the ring stuck on.
  useEffect(() => {
    if (!highlightWamid) return;
    const clear = setTimeout(() => setHighlightWamid(null), 2600);
    return () => clearTimeout(clear);
  }, [highlightWamid]);

  // "Reply to a specific message" state — WhatsApp Desktop UX. Lives here
  // (not in ComposeBox) because the trigger is a per-bubble action while
  // the quote preview + send live in the composer. Cleared when the user
  // switches chats so a stale quote never carries over.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  useEffect(() => {
    setReplyTo(null);
  }, [chatId]);

  // Stable per-bubble action handlers. MessageBubble is memoized, so these
  // take the target message/wamid as an argument instead of closing over a
  // per-message value — one function identity shared by every bubble, instead
  // of 200 fresh closures per render.
  const handleReply = useCallback((m: Message) => setReplyTo(m), []);
  const handleReact = useCallback(
    async (wamid: string, emoji: string) => {
      // Optimistic: paint the emoji (or its removal) immediately,
      // then confirm with Meta and revert only if the call fails.
      setOptimisticReactions((prev) => ({ ...prev, [wamid]: emoji }));
      try {
        await api("/api/whatsapp/messages/react", {
          method: "POST",
          body: { target_wamid: wamid, emoji },
        });
        onMessageSent?.();
      } catch (e) {
        setOptimisticReactions((prev) => {
          const next = { ...prev };
          delete next[wamid];
          return next;
        });
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [onMessageSent],
  );

  // Staged outgoing images (paste / drag-drop / attach button). Lives here
  // rather than in ComposeBox because the drag-drop target is the whole chat
  // surface (WhatsApp Desktop drops anywhere over the conversation), while the
  // preview + send live in the composer below. Cleared on chat switch so a
  // staged image never leaks into a different conversation.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  // Revoke object URLs when images are dropped from the queue or the chat
  // changes, so we don't leak blob: URLs across a long session.
  const addImages = useCallback(
    (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      if (imgs.length === 0) return;
      const accepted: File[] = [];
      let rejectedType = false;
      let rejectedSize = false;
      for (const f of imgs) {
        if (!IMAGE_ALLOWED_MIME.includes(f.type)) { rejectedType = true; continue; }
        if (f.size > IMAGE_MAX_BYTES) { rejectedSize = true; continue; }
        accepted.push(f);
      }
      if (rejectedType) toast.error(t("unsupportedImageType"));
      if (rejectedSize) toast.error(t("imageTooLarge"));
      if (accepted.length === 0) return;
      setPendingImages((curr) => {
        const room = Math.max(0, IMAGE_MAX_COUNT - curr.length);
        const next = accepted.slice(0, room).map((file) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          url: URL.createObjectURL(file),
        }));
        return [...curr, ...next];
      });
    },
    [t],
  );

  const removeImage = useCallback((id: string) => {
    setPendingImages((curr) => {
      const target = curr.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return curr.filter((p) => p.id !== id);
    });
  }, []);

  const clearImages = useCallback(() => {
    setPendingImages((curr) => {
      for (const p of curr) URL.revokeObjectURL(p.url);
      return [];
    });
  }, []);

  // Drop staged images (and revoke their preview URLs) whenever the chat
  // switches. Uses the functional updater so it doesn't depend on the array.
  useEffect(() => {
    setPendingImages((curr) => {
      for (const p of curr) URL.revokeObjectURL(p.url);
      return [];
    });
    dragDepth.current = 0;
    setDragActive(false);
  }, [chatId]);

  // Final safety net: revoke any remaining preview URLs on unmount.
  useEffect(() => {
    return () => {
      setPendingImages((curr) => {
        for (const p of curr) URL.revokeObjectURL(p.url);
        return curr;
      });
    };
  }, []);

  // Drag-and-drop over the whole chat surface (WhatsApp Desktop UX). We track
  // enter/leave depth so the overlay doesn't flicker as the cursor moves over
  // child elements. Only armed inside the 24h window — drops are ignored
  // otherwise since sending is disabled.
  const onDragEnter = (e: React.DragEvent) => {
    if (!withinWindow) return;
    if (!Array.from(e.dataTransfer.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!withinWindow) return;
    if (!Array.from(e.dataTransfer.types ?? []).includes("Files")) return;
    e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!withinWindow) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!withinWindow) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) addImages(files);
  };

  // Build a lookup for reactions: target_wamid → reaction emojis.
  // We keep at most one reaction per direction (matches WhatsApp UX:
  // each side can leave one emoji per message; later reactions replace).
  // Optimistic overrides are layered on top so a freshly-tapped emoji shows
  // instantly (and a removal hides instantly).
  const reactionsByTarget = useMemo(() => {
    const map = new Map<string, Array<{ emoji: string; direction: string }>>();
    for (const m of messages) {
      if (m.is_reaction && m.reply_to_wamid && m.reaction_emoji) {
        const list = map.get(m.reply_to_wamid) ?? [];
        const filtered = list.filter((r) => r.direction !== m.direction);
        filtered.push({ emoji: m.reaction_emoji, direction: m.direction });
        map.set(m.reply_to_wamid, filtered);
      }
    }
    for (const [target, emoji] of Object.entries(optimisticReactions)) {
      const list = (map.get(target) ?? []).filter((r) => r.direction !== "outgoing");
      if (emoji) list.push({ emoji, direction: "outgoing" });
      map.set(target, list);
    }
    return map;
  }, [messages, optimisticReactions]);

  const visibleMessages = useMemo(
    () => mergedMessages.filter((m) => !m.is_reaction),
    [mergedMessages],
  );

  // Per-message day-separator labels, precomputed once per message-list
  // change. Doing this inline in the render loop meant 2×N Date allocations
  // plus a toLocaleDateString (fresh Intl formatter) per day group on every
  // keystroke/render. Labels refresh whenever the list changes (every poll),
  // so the relative "today"/"yesterday" wording stays current.
  const dayLabels = useMemo(() => {
    return visibleMessages.map((m, i) => {
      const prev = i > 0 ? visibleMessages[i - 1] : null;
      const showDay =
        !prev || !isSameDay(new Date(prev.received_at), new Date(m.received_at));
      return showDay ? formatDaySeparator(new Date(m.received_at), locale, t) : null;
    });
  }, [visibleMessages, locale, t]);

  // ── In-chat search ────────────────────────────────────────────────────────
  // Collapsed behind an icon in the header (compact-UI principle). When open,
  // matches the query against each message's text/transcript/OCR over the
  // loaded window, highlights the hits, and lets the user step between them
  // (oldest → newest) with the up/down controls, scrolling each into view.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Wamids of matching messages, in chronological (oldest → newest) order.
  const matchWamids = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 1) return [] as string[];
    const hits: string[] = [];
    for (const m of visibleMessages) {
      const hay = `${m.body_text ?? ""}\n${m.audio_transcript ?? ""}\n${m.media_ocr_text ?? ""}`.toLowerCase();
      if (hay.includes(q)) hits.push(m.wamid);
    }
    return hits;
  }, [visibleMessages, searchQuery]);

  const matchSet = useMemo(() => new Set(matchWamids), [matchWamids]);
  const currentMatchWamid = matchWamids[searchIndex] ?? null;

  // Newest match comes first under the cursor whenever the query changes (the
  // chat is bottom-anchored, so the most recent hit is the natural landing
  // spot). Read the latest matches via a ref so this only re-runs on a query
  // edit, not on every background re-poll that nudges the message count.
  // The ref is synced in its own commit-time effect (declared first so it
  // runs before the reset effect on a query-change render) rather than during
  // render, which would be a side-effect in the render body.
  const matchWamidsRef = useRef<string[]>([]);
  useEffect(() => {
    matchWamidsRef.current = matchWamids;
  });
  useEffect(() => {
    if (!searchOpen) return;
    const n = matchWamidsRef.current.length;
    setSearchIndex(n > 0 ? n - 1 : 0);
  }, [searchQuery, searchOpen]);

  // Scroll the active match into view (and keep the index in bounds as the
  // match set shrinks/grows).
  useEffect(() => {
    if (!searchOpen) return;
    if (matchWamids.length === 0) return;
    const idx = Math.min(searchIndex, matchWamids.length - 1);
    const wamid = matchWamids[idx];
    if (!wamid) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-wamid="${CSS.escape(wamid)}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [searchIndex, searchOpen, matchWamids]);

  const closeChatSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
  }, []);

  const gotoPrevMatch = useCallback(() => {
    setSearchIndex((i) => (i <= 0 ? Math.max(0, matchWamids.length - 1) : i - 1));
  }, [matchWamids.length]);
  const gotoNextMatch = useCallback(() => {
    setSearchIndex((i) => (i >= matchWamids.length - 1 ? 0 : i + 1));
  }, [matchWamids.length]);

  // Reset search when switching conversations.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
  }, [chatId]);

  // Focus the input when the search bar opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const displayName =
    thread?.custom_name?.trim() ||
    thread?.from_name?.trim() ||
    thread?.from_phone ||
    chatId;

  // Inline rename state. Click the pencil → input replaces the name.
  // Saving issues a PATCH, then nudges the parent to refresh the thread
  // list so the rename propagates to the left pane.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);

  const startRename = () => {
    setRenameValue(thread?.custom_name?.trim() || thread?.from_name?.trim() || "");
    setRenaming(true);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    setRenameSaving(true);
    try {
      await api(`/api/whatsapp/threads/${encodeURIComponent(chatId)}/name`, {
        method: "PATCH",
        body: { custom_name: next || null },
      });
      setRenaming(false);
      onContactRenamed?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameSaving(false);
    }
  };

  // Quick-lookup map for reply quotes — when a message has reply_to_wamid,
  // we want to surface the original message's preview above the bubble.
  const messagesByWamid = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of mergedMessages) map.set(m.wamid, m);
    return map;
  }, [mergedMessages]);

  // Map each whatsapp_message → tasks created from it. Two strategies:
  //   1. EXACT match by wamid — when the task came from a per-message
  //      whatsapp_echo source_message, the server returns source_wamid.
  //      Use it directly.
  //   2. HEURISTIC by time — for legacy thread-level tasks
  //      (source_type='whatsapp'): assign each task to the LATEST message
  //      whose received_at is at or before task.created_at. Part 3 runs
  //      on a freshly-updated thread so the triggering message is the
  //      most recent one when the task is created.
  const tasksByMessageId = useMemo(() => {
    const map = new Map<string, ChatTask[]>();
    if (tasks.length === 0 || messages.length === 0) return map;
    const messageList = messages.filter((m) => !m.is_reaction);
    const messageByWamid = new Map<string, Message>();
    for (const m of messageList) messageByWamid.set(m.wamid, m);

    for (const t of tasks) {
      // Strategy 1: exact wamid match (preferred when present).
      if (t.source_wamid) {
        const exact = messageByWamid.get(t.source_wamid);
        if (exact) {
          const existing = map.get(exact.id) ?? [];
          existing.push(t);
          map.set(exact.id, existing);
          continue;
        }
      }
      // Strategy 2: time-window heuristic for legacy thread tasks.
      const taskTime = new Date(t.created_at).getTime();
      let bestMessage: Message | null = null;
      for (const m of messageList) {
        if (!m.received_at) continue;
        const mt = new Date(m.received_at).getTime();
        if (mt <= taskTime) bestMessage = m;
        else break;
      }
      if (bestMessage) {
        const existing = map.get(bestMessage.id) ?? [];
        existing.push(t);
        map.set(bestMessage.id, existing);
      }
    }
    return map;
  }, [tasks, messages]);

  // "Last seen" approximation. The Meta Cloud API doesn't expose real
  // presence/last-seen for arbitrary contacts (that's a WhatsApp consumer
  // privacy feature). The best signal we have is the most recent moment we
  // know the contact had WhatsApp open: either an incoming message they
  // sent, or a `read` receipt on something we sent. We take the max.
  const lastSeenAt = useMemo(() => {
    let best: number | null = null;
    for (const m of messages) {
      if (m.is_reaction) continue;
      if (m.direction === "incoming" && m.received_at) {
        const t = new Date(m.received_at).getTime();
        if (best === null || t > best) best = t;
      }
      if (m.direction === "outgoing" && m.read_at) {
        const t = new Date(m.read_at).getTime();
        if (best === null || t > best) best = t;
      }
    }
    return best ? new Date(best) : null;
  }, [messages]);

  // 24h-window status. We can compute it from the messages we already
  // have — find the most recent incoming message; if it's within 24h,
  // free-form sending is allowed.
  const { withinWindow, windowExpiresAt } = useMemo(() => {
    const latestIncoming = [...messages]
      .reverse()
      .find((m) => m.direction === "incoming" && !m.is_reaction);
    if (!latestIncoming?.received_at) {
      return { withinWindow: false as const, windowExpiresAt: null };
    }
    const t = new Date(latestIncoming.received_at).getTime();
    const expires = t + SEND_WINDOW_MS;
    return {
      withinWindow: Date.now() < expires,
      windowExpiresAt: new Date(expires),
    };
  }, [messages]);

  return (
    <div
      className="relative flex h-full flex-col rounded-lg border bg-card overflow-hidden"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag-and-drop overlay — shown while a file is dragged over the chat
          (WhatsApp Desktop UX). Pointer-events stay off so the underlying drag
          events keep firing on the chat surface, not on the overlay. */}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-card/90 px-8 py-6 text-primary shadow-lg">
            <ImagePlus className="h-8 w-8" />
            <p className="text-sm font-medium">{t("dropImageHere")}</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-2 border-b bg-muted/40 p-2">
        <IconButton
          label={t("backToChats")}
          color="neutral"
          className={alwaysShowBack ? "" : "md:hidden"}
          onClick={onBack}
        >
          <ArrowLeft />
        </IconButton>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void submitRename(); }
                  if (e.key === "Escape") { e.preventDefault(); setRenaming(false); }
                }}
                placeholder={t("renameContactPlaceholder")}
                className="flex-1 min-w-0 rounded border bg-background px-2 py-0.5 text-sm"
                maxLength={120}
                disabled={renameSaving}
              />
              <IconButton
                label={t("renameContactSave")}
                color="green"
                className="h-6 w-6 md:h-6 md:w-6"
                onClick={() => void submitRename()}
                disabled={renameSaving}
              >
                {renameSaving ? <Loader2 className="animate-spin" /> : <Check />}
              </IconButton>
              <IconButton
                label={t("renameContactCancel")}
                color="neutral"
                className="h-6 w-6 md:h-6 md:w-6"
                onClick={() => setRenaming(false)}
                disabled={renameSaving}
              >
                <X />
              </IconButton>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <p className="font-medium text-sm truncate">{displayName}</p>
              <IconButton
                label={t("renameContact")}
                color="primary"
                className="h-6 w-6 md:h-6 md:w-6 shrink-0"
                onClick={startRename}
              >
                <Pencil />
              </IconButton>
            </div>
          )}
          {/* Sub-line: "active a few minutes ago" approximation from
              incoming + read receipts (real WhatsApp last-seen isn't
              exposed by the Cloud API). Fall back to phone if no activity. */}
          {lastSeenAt ? (
            <p className="text-xs text-muted-foreground truncate">
              {formatLastSeen(lastSeenAt, t)}
            </p>
          ) : (
            thread?.from_phone && thread.from_phone !== displayName && (
              <p className="text-xs text-muted-foreground truncate" dir="ltr">
                {thread.from_phone}
              </p>
            )
          )}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {!searchOpen && (
          <IconButton
            label={t("chatSearchOpen")}
            color="neutral"
            className="shrink-0"
            onClick={() => setSearchOpen(true)}
          >
            <Search />
          </IconButton>
        )}
      </div>

      {/* In-chat search bar — collapsed behind the header icon; when open it
          shows the query input, a match counter, prev/next steppers (oldest →
          newest, like WhatsApp), and a close button. */}
      {searchOpen && (
        <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2 py-1.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeChatSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (matchWamids.length > 0) {
                  // Enter steps to the previous (older) match; Shift+Enter to
                  // the next (newer) one — mirrors find-in-page conventions.
                  if (e.shiftKey) gotoNextMatch();
                  else gotoPrevMatch();
                }
              }
            }}
            placeholder={t("chatSearchPlaceholder")}
            aria-label={t("chatSearchPlaceholder")}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
            {searchQuery.trim()
              ? matchWamids.length > 0
                ? t("chatSearchCount", {
                    current: Math.min(searchIndex, matchWamids.length - 1) + 1,
                    total: matchWamids.length,
                  })
                : t("chatSearchNoMatch")
              : ""}
          </span>
          <IconButton
            label={t("chatSearchPrev")}
            color="neutral"
            className="h-7 w-7 md:h-7 md:w-7 shrink-0"
            onClick={gotoPrevMatch}
            disabled={matchWamids.length === 0}
          >
            <ChevronUp />
          </IconButton>
          <IconButton
            label={t("chatSearchNext")}
            color="neutral"
            className="h-7 w-7 md:h-7 md:w-7 shrink-0"
            onClick={gotoNextMatch}
            disabled={matchWamids.length === 0}
          >
            <ChevronDown />
          </IconButton>
          <IconButton
            label={t("searchClose")}
            color="neutral"
            className="h-7 w-7 md:h-7 md:w-7 shrink-0"
            onClick={closeChatSearch}
          >
            <X />
          </IconButton>
        </div>
      )}

      {/* Messages — force LTR on the container so the per-message
          alignment logic below stays consistent regardless of the app's
          interface locale. Each bubble's own `dir` is set based on the
          language of its body_text. */}
      <div
        ref={scrollRef}
        dir="ltr"
        className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-muted"
      >
        {visibleMessages.length === 0 && !loading && (
          <p className="text-center text-sm text-muted-foreground py-8">{t("emptyChat")}</p>
        )}
        {visibleMessages.map((m, i) => {
          // WhatsApp-style day separators: a centered date pill before the
          // first message of each new calendar day. Per-message dates live in
          // the timestamp tooltip below, so the stream stays uncluttered.
          // Labels are precomputed in the `dayLabels` memo above.
          const dayLabel = dayLabels[i] ?? null;
          return (
            <Fragment key={m.id}>
              {dayLabel !== null && <DaySeparator label={dayLabel} />}
              <MessageBubble
                message={m}
                highlighted={highlightWamid === m.wamid || currentMatchWamid === m.wamid}
                searchHit={searchOpen && matchSet.has(m.wamid) && currentMatchWamid !== m.wamid}
                reactions={reactionsByTarget.get(m.wamid) ?? EMPTY_REACTIONS}
                quotedMessage={m.reply_to_wamid ? messagesByWamid.get(m.reply_to_wamid) : undefined}
                relatedTasks={tasksByMessageId.get(m.id) ?? EMPTY_TASKS}
                locale={locale}
                canReact={withinWindow}
                onReply={handleReply}
                onReact={handleReact}
              />
            </Fragment>
          );
        })}
      </div>

      {/* Compose box — Meta only allows free-form replies within 24h of the
          customer's last message. Outside the window, the input is disabled
          and we explain why. */}
      <ComposeBox
        chatId={chatId}
        withinWindow={withinWindow}
        windowExpiresAt={windowExpiresAt}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        initialDraft={initialDraft}
        onSent={onMessageSent}
        onPendingAdd={addPendingText}
        onPendingResolve={resolvePendingText}
        onPendingRemove={removePendingText}
        pendingImages={pendingImages}
        onAddImages={addImages}
        onRemoveImage={removeImage}
        onClearImages={clearImages}
      />
    </div>
  );
}

// Drop everything that isn't a letter, digit, or single space, then
// lowercase. Used to decide if a Haiku "polish" is substantive enough
// to surface — "Appeal this decision →" vs "Appeal this decision."
// collapse to the same string here.
function normaliseForCompare(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function ComposeBox({
  chatId,
  withinWindow,
  windowExpiresAt,
  replyTo,
  onClearReply,
  initialDraft,
  onSent,
  onPendingAdd,
  onPendingResolve,
  onPendingRemove,
  pendingImages,
  onAddImages,
  onRemoveImage,
  onClearImages,
}: {
  chatId: string;
  withinWindow: boolean;
  windowExpiresAt: Date | null;
  /** When set, the next message is sent as a reply quoting this message
   *  (mirrors WhatsApp Desktop). Null = normal send. */
  replyTo: Message | null;
  /** Clears the active reply (X on the quote bar / after a successful send). */
  onClearReply: () => void;
  /** One-shot prefill (from the side-panel; the full page uses ?draft=). */
  initialDraft?: string | null;
  onSent?: () => void;
  /** Optimistic-send plumbing (owned by ThreadView, which holds the bubble
   *  list): add a pending bubble (returns its temp id), resolve it with the
   *  real wamid on success, or remove it on failure. */
  onPendingAdd: (body: string, replyToWamid: string | null) => string;
  onPendingResolve: (id: string, wamid: string) => void;
  onPendingRemove: (id: string) => void;
  /** Images staged for sending (paste / drag-drop / attach). Owned by the
   *  parent ThreadView so the drag-drop target can be the whole chat surface. */
  pendingImages: PendingImage[];
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  onClearImages: () => void;
}) {
  const t = useTranslations("whatsappPage");
  const searchParams = useSearchParams();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasImages = pendingImages.length > 0;

  // Focus the composer the moment the user picks a message to reply to,
  // so they can start typing immediately (WhatsApp Desktop behaviour).
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Prefill the composer when arriving from a smrtTask "open in WhatsApp"
  // draft (?draft=…). Read once, then strip the param so it doesn't refill
  // after the user edits or sends.
  const draftConsumedRef = useRef(false);
  useEffect(() => {
    if (draftConsumedRef.current) return;
    const draft = searchParams.get("draft");
    if (draft) {
      draftConsumedRef.current = true;
      setText(draft);
      const url = new URL(window.location.href);
      url.searchParams.delete("draft");
      window.history.replaceState(null, "", url.toString());
    }
  }, [searchParams]);

  // Prop-driven prefill (side-panel path — no URL param to read). Shares the
  // consume guard with the ?draft= path so neither double-fills the textarea.
  useEffect(() => {
    if (draftConsumedRef.current) return;
    if (initialDraft && initialDraft.trim()) {
      draftConsumedRef.current = true;
      setText(initialDraft);
    }
  }, [initialDraft]);
  const [transcribing, setTranscribing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // True once Haiku has cleared the current text as "good as-is" — used
  // to render a small ✓ confirming the English is fine. Reset every time
  // the text changes.
  const [englishApproved, setEnglishApproved] = useState(false);
  // Remember the last text we already sent to the English checker so we
  // don't re-call it on every keystroke after the user paused once.
  const lastCheckedRef = useRef<string>("");

  // Dictation recording state (mic → transcribe to text). We only spin up
  // MediaRecorder when the user taps the mic button (and the browser supports
  // it) — no eager getUserMedia prompt.
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Voice-note recording state (mic → send as an actual WhatsApp voice note,
  // like WhatsApp Web's mic button). Distinct from the dictation flow above:
  // here the recording is uploaded and sent to the chat as audio (transcoded to
  // ogg/opus server-side), never transcribed into the textarea.
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [sendingVoice, setSendingVoice] = useState(false);
  // The live stream, exposed as state (not just the ref) so the waveform meter
  // can subscribe to it while recording.
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceCancelledRef = useRef(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Per-message direction inside the input itself so Hebrew & English both
  // render naturally. Defaults to RTL when the field is empty (the most
  // common case for our Hebrew-speaking operator).
  const dir = detectMessageDir(text) === "rtl" || text.trim() === "" ? "rtl" : "ltr";

  // English-detection — drives the auto-checker. We only run the
  // Haiku call on text that's >= 4 chars, has 3+ Latin letters, and
  // no Hebrew/Arabic. (Mixed-Hebrew text doesn't need an English check.)
  const looksEnglish = useMemo(() => {
    const trimmed = text.trim();
    if (trimmed.length < 4) return false;
    if (/[֐-ۿ]/.test(trimmed)) return false;
    return (trimmed.match(/[A-Za-z]/g) ?? []).length >= 3;
  }, [text]);

  async function startRecording() {
    if (recording) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t("micUnsupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        await sendForTranscription(blob);
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("micPermissionError"));
    }
  }

  function stopRecording() {
    const mr = recorderRef.current;
    if (!mr) return;
    if (mr.state !== "inactive") mr.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function sendForTranscription(blob: Blob) {
    setTranscribing(true);
    try {
      const base64 = await blobToBase64(blob);

      const { text: transcript } = await api<{ text: string }>(
        "/api/whatsapp/compose/transcribe",
        { method: "POST", body: { audio_base64: base64, mime_type: blob.type } },
      );
      const cleaned = (transcript ?? "").replace(/^\s+|\s+$/g, "");
      if (cleaned) {
        // Append to whatever is already in the box so a typed prefix
        // isn't clobbered.
        setText((prev) => (prev.trim() ? prev.trim() + " " + cleaned : cleaned));
      } else {
        toast.error(t("transcribeEmpty"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
    }
  }

  // ── Voice note (WhatsApp-Web-style mic) ──────────────────────────────────
  const stopVoiceTimer = useCallback(() => {
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }, []);

  // Upload the recorded blob and send it as a voice note. The server transcodes
  // to ogg/opus, sends via Meta, and inserts the outgoing row — onSent() then
  // refetches so the bubble (native <audio> player) appears.
  async function sendVoiceNote(blob: Blob) {
    setSendingVoice(true);
    try {
      const base64 = await blobToBase64(blob);
      await api("/api/whatsapp/messages/send-audio", {
        method: "POST",
        body: { to_phone: chatId, audio_base64: base64, mime_type: blob.type },
      });
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSendingVoice(false);
    }
  }

  async function startVoiceNote() {
    if (voiceRecording || recording || transcribing || sendingVoice) return;
    if (!withinWindow) {
      toast.error(t("windowClosedShort"));
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t("micUnsupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      setVoiceStream(stream);
      voiceChunksRef.current = [];
      voiceCancelledRef.current = false;
      // A low capture bitrate keeps the upload small; the server re-encodes to
      // 32 kbps opus regardless. Fall back to defaults if the option is rejected.
      let mr: MediaRecorder;
      try {
        mr = new MediaRecorder(stream, { audioBitsPerSecond: 48000 });
      } catch {
        mr = new MediaRecorder(stream);
      }
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) voiceChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stopVoiceTimer();
        stream.getTracks().forEach((tr) => tr.stop());
        voiceStreamRef.current = null;
        setVoiceStream(null);
        const chunks = voiceChunksRef.current;
        voiceChunksRef.current = [];
        // Cancelled (trash button / chat switch): discard without sending.
        if (voiceCancelledRef.current || chunks.length === 0) return;
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        await sendVoiceNote(blob);
      };
      mr.start();
      voiceRecorderRef.current = mr;
      setVoiceElapsed(0);
      setVoiceRecording(true);
      voiceTimerRef.current = setInterval(() => {
        setVoiceElapsed((s) => s + 1);
      }, 1000);
    } catch (e) {
      // Release the mic + reset state if anything after getUserMedia threw
      // (e.g. MediaRecorder construction) — otherwise the track stays live.
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      voiceStreamRef.current = null;
      setVoiceStream(null);
      setVoiceRecording(false);
      stopVoiceTimer();
      toast.error(e instanceof Error ? e.message : t("micPermissionError"));
    }
  }

  // Stop recording and send (the mic's Send button, and the auto-stop at the
  // duration cap). The recorder's onstop handler does the actual upload.
  const finishVoiceNote = useCallback(() => {
    const mr = voiceRecorderRef.current;
    if (!mr) return;
    voiceCancelledRef.current = false;
    voiceRecorderRef.current = null;
    setVoiceRecording(false);
    if (mr.state !== "inactive") mr.stop();
  }, []);

  // Discard the recording (trash button) — stop the recorder but flag it so
  // onstop drops the audio instead of sending.
  const cancelVoiceNote = useCallback(() => {
    const mr = voiceRecorderRef.current;
    voiceCancelledRef.current = true;
    voiceRecorderRef.current = null;
    setVoiceRecording(false);
    stopVoiceTimer();
    setVoiceElapsed(0);
    if (mr && mr.state !== "inactive") {
      mr.stop();
    } else {
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      voiceStreamRef.current = null;
      setVoiceStream(null);
    }
  }, [stopVoiceTimer]);

  // Auto-stop + send when the recording hits the duration cap.
  useEffect(() => {
    if (voiceRecording && voiceElapsed >= VOICE_NOTE_MAX_SECONDS) {
      finishVoiceNote();
    }
  }, [voiceRecording, voiceElapsed, finishVoiceNote]);

  // Switching chats (or unmount) mid-recording: drop it so a half-recorded
  // note never lands in the wrong conversation, and release the mic.
  useEffect(() => {
    return () => {
      if (voiceRecorderRef.current) {
        voiceCancelledRef.current = true;
        const mr = voiceRecorderRef.current;
        voiceRecorderRef.current = null;
        if (mr.state !== "inactive") mr.stop();
      }
      stopVoiceTimer();
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      voiceStreamRef.current = null;
      setVoiceStream(null);
    };
  }, [chatId, stopVoiceTimer]);

  // Auto-check English: debounce 1.2s after the user stops typing, then
  // run the cheap Haiku polish call if the text looks English and hasn't
  // been checked yet. Cancels in-flight if the user keeps typing — we
  // never want a stale suggestion overwriting the user's most recent
  // input.
  useEffect(() => {
    const trimmed = text.trim();
    if (!looksEnglish) {
      // Clear any prior suggestion if the user switched language.
      if (suggestion) setSuggestion(null);
      if (englishApproved) setEnglishApproved(false);
      return;
    }
    if (trimmed === lastCheckedRef.current) return;
    // Reset approval the moment the text changes — the ✓ only reflects
    // the most recently checked draft.
    setEnglishApproved(false);

    let cancelled = false;
    const handle = setTimeout(async () => {
      lastCheckedRef.current = trimmed;
      setChecking(true);
      try {
        const { suggestion: s, changed } = await api<{ suggestion: string; changed: boolean }>(
          "/api/whatsapp/compose/check-english",
          { method: "POST", body: { text: trimmed } },
        );
        if (cancelled) return;
        // Decide between three outcomes: substantive suggestion, "good
        // as-is" approval, or no signal. Haiku flips `changed` on any
        // byte diff, so we compare a lightly normalised form
        // (letters+digits only, lowercase) to filter out trivial
        // punctuation tweaks like a stripped trailing arrow.
        const substantive =
          changed && s !== trimmed && normaliseForCompare(s) !== normaliseForCompare(trimmed);
        if (substantive) {
          setSuggestion(s);
          setEnglishApproved(false);
        } else {
          setSuggestion(null);
          setEnglishApproved(true);
        }
      } catch {
        // Silent — the auto-check should never interrupt the user's flow.
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [text, looksEnglish, suggestion, englishApproved]);

  function rejectSuggestion() {
    setSuggestion(null);
  }

  // Send `body` to Meta. Used by both the Send button (with the
  // textarea contents) and the "Replace" suggestion button (with the
  // polished text — straight to the wire, skipping the textarea).
  async function sendMessage(body: string, opts: { restoreOnFail?: boolean } = {}) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!withinWindow) {
      toast.error(t("windowClosedShort"));
      return;
    }
    // Capture the reply target before we clear it — the send is async and
    // the quote bar is dismissed optimistically below.
    const replyToWamid = replyTo?.wamid ?? null;
    // Drop the textarea + suggestion + reply quote immediately so the
    // operator can start typing the next message while Meta's send call
    // (~1-2s) finishes in the background.
    setText("");
    setSuggestion(null);
    setEnglishApproved(false);
    lastCheckedRef.current = "";
    onClearReply();
    setSending(true);
    // Paint the bubble instantly (WhatsApp-Web feel) with a clock, then
    // confirm with Meta. The real row arrives on the next refetch and dedupes.
    const pendingId = onPendingAdd(trimmed, replyToWamid);
    try {
      const { wamid } = await api<{ ok: boolean; wamid: string }>("/api/whatsapp/messages/send", {
        method: "POST",
        body: {
          to_phone: chatId,
          text: trimmed,
          ...(replyToWamid ? { reply_to_wamid: replyToWamid } : {}),
        },
      });
      onPendingResolve(pendingId, wamid);
      onSent?.();
    } catch (e) {
      // Roll back the optimistic bubble; only the textarea-driven send
      // restores the draft (accepting a polish suggestion already wiped the
      // original, so restoring it would feel surprising).
      onPendingRemove(pendingId);
      if (opts.restoreOnFail) {
        setText((curr) => (curr.trim() ? curr : trimmed));
      }
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // Accept the polish suggestion = send it immediately. The operator
  // already saw the text and chose to use it; making them press a
  // second button would be friction.
  function acceptSuggestion() {
    if (!suggestion) return;
    sendMessage(suggestion);
  }

  // Send each staged image as its own Meta `image` message. The composer text
  // rides along as the caption on the FIRST image only (mirrors WhatsApp's
  // single-caption-per-album behaviour); the rest go captionless. Optimistic:
  // clear the queue + text immediately so the operator can keep working while
  // the uploads finish in the background.
  async function sendImages() {
    if (!withinWindow) {
      toast.error(t("windowClosedShort"));
      return;
    }
    if (pendingImages.length === 0) return;
    const imgs = pendingImages;
    const caption = text.trim();
    onClearReply();
    setSending(true);
    // Track which staged images actually made it out. On a mid-batch failure
    // we drop only those from the queue and keep the rest staged (with the
    // caption intact) so the operator can retry — rather than silently losing
    // images that never sent.
    const sentIds: string[] = [];
    try {
      // Sequential on purpose — images must arrive in the order the user
      // staged them, so we await each send before starting the next.
      for (let i = 0; i < imgs.length; i++) {
        const base64 = await fileToBase64(imgs[i].file);
        await api("/api/whatsapp/messages/send-image", {
          method: "POST",
          body: {
            to_phone: chatId,
            image_base64: base64,
            mime_type: imgs[i].file.type,
            filename: imgs[i].file.name,
            ...(i === 0 && caption ? { caption } : {}),
          },
        });
        sentIds.push(imgs[i].id);
      }
      // Full success — clear the composer + queue.
      setText("");
      setSuggestion(null);
      setEnglishApproved(false);
      lastCheckedRef.current = "";
      onClearImages();
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      // Remove the ones that did send; leave the remainder staged for retry.
      for (const id of sentIds) onRemoveImage(id);
      if (sentIds.length > 0) onSent?.();
    } finally {
      setSending(false);
    }
  }

  async function handleSend() {
    // Guard the keyboard path too: the Send button is disabled while sending,
    // but Enter bypasses it. sendImages keeps the queue populated during
    // upload (for retry), so without this a second Enter would re-send the
    // same images in a parallel loop.
    if (sending) return;
    if (hasImages) {
      await sendImages();
      return;
    }
    await sendMessage(text, { restoreOnFail: true });
  }

  // Pull image files out of a paste event (screenshots, copied pictures). When
  // an image is present we consume the paste so the (usually empty) text part
  // doesn't also land in the textarea.
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!withinWindow) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      onAddImages(files);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (standard chat UX).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t bg-muted/40 p-2 space-y-1.5">
      {!withinWindow && (
        <p className="text-[11px] bg-status-warn-bg text-status-warn border rounded px-2 py-1">
          {t("windowClosed")}
        </p>
      )}
      {withinWindow && windowExpiresAt && (
        <p className="text-[10px] text-muted-foreground">
          {t("windowOpenUntil", { time: windowExpiresAt.toLocaleString() })}
        </p>
      )}

      {/* English polish suggestion — appears automatically ~1.2s after the
          user stops typing English text. Accept replaces; X dismisses. */}
      {suggestion && (
        <div className="rounded border border-primary bg-accent p-2 space-y-1.5" dir="ltr">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-primary">
            <Sparkles className="h-3 w-3" />
            <span>{t("englishSuggestion")}</span>
          </div>
          <p className="text-sm text-accent-foreground whitespace-pre-wrap break-words">{suggestion}</p>
          <div className="flex items-center gap-1 justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] gap-1"
              onClick={rejectSuggestion}
            >
              <X className="h-3 w-3" />
              {t("englishKeepMine")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-[11px] gap-1"
              onClick={acceptSuggestion}
              disabled={!withinWindow}
            >
              <Send className="h-3 w-3" />
              {t("englishSendPolished")}
            </Button>
          </div>
        </div>
      )}

      {/* Recording / transcribing / sending status line. Shows while any is
          active so the user knows what's happening. (Voice-note recording has
          its own inline bar below; this covers its upload phase.) */}
      {(recording || transcribing || sendingVoice) && (
        <div className="flex items-center gap-1.5 text-[11px] bg-status-ok-bg text-status-ok border rounded px-2 py-1">
          {recording && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-status-late animate-pulse" />
              {t("recording")}
            </>
          )}
          {transcribing && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("transcribing")}
            </>
          )}
          {sendingVoice && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("sendingVoiceNote")}
            </>
          )}
        </div>
      )}

      {/* Reply quote bar — WhatsApp Desktop shows the message you're
          replying to directly above the input, with an X to cancel. The
          accent bar colour matches the quoted message's direction (green
          for your own outgoing, primary for the contact's incoming). */}
      {replyTo && withinWindow && (
        <div className="flex items-stretch gap-2 rounded bg-muted/60">
          <div
            className={`flex-1 min-w-0 rounded border-s-4 bg-muted px-2 py-1 ${
              replyTo.direction === "outgoing" ? "border-status-ok" : "border-primary"
            }`}
            dir={detectMessageDir(replyTo.body_text)}
          >
            <p className="text-[10px] font-medium text-muted-foreground">
              {t("replyingTo", {
                name:
                  replyTo.direction === "outgoing"
                    ? t("you")
                    : replyTo.from_name?.trim() || replyTo.from_phone || t("contact"),
              })}
            </p>
            <p className="line-clamp-1 break-words text-[11px] text-muted-foreground/80">
              {replyTo.body_text?.slice(0, 200) || `[${replyTo.message_type}]`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            className="shrink-0 self-center rounded-full p-1 hover:bg-muted"
            aria-label={t("cancelReply")}
            title={t("cancelReply")}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Staged-image preview strip — thumbnails of pasted/dropped/attached
          images, each with an X to drop it. The textarea below doubles as the
          caption (applied to the first image on send). */}
      {hasImages && (
        <div className="flex flex-wrap gap-2 rounded border bg-muted/40 p-2">
          {pendingImages.map((img) => (
            <div key={img.id} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.file.name} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveImage(img.id)}
                className="absolute end-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground shadow hover:bg-background"
                aria-label={t("removeImage")}
                title={t("removeImage")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {voiceRecording ? (
        /* Voice-note recording bar — replaces the composer while recording,
           mirroring WhatsApp Web's mic UX: a trash button to discard, a live
           timer, and a send button. */
        <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={cancelVoiceNote}
            aria-label={t("cancelVoiceNote")}
            title={t("cancelVoiceNote")}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-status-late animate-pulse" />
          <span className="shrink-0 text-sm tabular-nums text-foreground" dir="ltr">
            {fmtDuration(voiceElapsed)}
          </span>
          {/* Live mic-level meter — immediate "it's recording and hearing me"
              feedback, like WhatsApp Web. */}
          <div className="min-w-0 flex-1">
            {voiceStream && <RecordingWaveform stream={voiceStream} />}
          </div>
          <Button
            type="button"
            size="icon"
            onClick={finishVoiceNote}
            aria-label={t("sendVoiceNote")}
            title={t("sendVoiceNote")}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2 items-end">
          {/* Hidden file input behind the attach button — the primary path on
              mobile (and a fallback to paste/drag on desktop). */}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ALLOWED_MIME.join(",")}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onAddImages(files);
              // Reset so re-picking the same file fires onChange again.
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={!withinWindow || transcribing || sendingVoice}
            onClick={() => fileInputRef.current?.click()}
            aria-label={t("attachImage")}
            title={t("attachImage")}
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          {/* Dictation mic — records and transcribes into the textarea. */}
          <Button
            type="button"
            size="icon"
            variant={recording ? "destructive" : "outline"}
            disabled={!withinWindow || transcribing || sendingVoice}
            onClick={recording ? stopRecording : startRecording}
            aria-label={recording ? t("stopRecording") : t("startRecording")}
            title={recording ? t("stopRecording") : t("startRecording")}
          >
            {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          {/* Voice-note mic — records and sends an actual audio message. */}
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={!withinWindow || recording || transcribing || sendingVoice}
            onClick={startVoiceNote}
            aria-label={t("startVoiceNote")}
            title={t("startVoiceNote")}
          >
            {sendingVoice ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}
          </Button>
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              !withinWindow
                ? t("composeDisabled")
                : hasImages
                  ? t("imageCaptionPlaceholder")
                  : t("composePlaceholder")
            }
            disabled={!withinWindow || transcribing}
            dir={dir}
            rows={1}
            className="resize-none min-h-[40px] max-h-[140px] text-sm"
          />
          <Button
            type="button"
            onClick={handleSend}
            disabled={!withinWindow || sending || (!text.trim() && !hasImages)}
            size="icon"
            aria-label={hasImages ? t("sendImage") : t("send")}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
      {/* Tiny status line for the in-flight English polish call — a
          subtle hint so the user knows the AI is thinking. */}
      {checking && !suggestion && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="h-2.5 w-2.5" />
          {t("englishChecking")}
        </p>
      )}
      {/* Positive confirmation: Haiku reviewed the draft and found
          nothing to fix. Only shown when there's nothing else
          competing for the slot (no in-flight check, no suggestion). */}
      {englishApproved && !checking && !suggestion && (
        <p className="text-[10px] text-status-ok flex items-center gap-1">
          <Check className="h-2.5 w-2.5" />
          {t("englishApproved")}
        </p>
      )}
    </div>
  );
}

/** Quick-react palette — the same six emojis WhatsApp Web shows by default. */
const QUICK_EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"] as const;

/** Cap on expired-signed-URL refetches per bubble (see onMediaError): stops a
 *  pathological loop where every freshly-minted URL errors again (e.g. the
 *  media object was deleted from Storage). */
const MEDIA_ERROR_RETRY_CAP = 3;

// Memoized: the chat surface re-renders on every search keystroke and every
// background poll, but a bubble whose props are unchanged (the vast majority)
// must not re-render — every prop passed from ThreadView is kept referentially
// stable across unrelated renders (stable handlers, memoized lookups, hoisted
// empty fallbacks).
const MessageBubble = memo(function MessageBubble({
  message,
  highlighted,
  searchHit,
  reactions,
  quotedMessage,
  relatedTasks,
  locale,
  canReact,
  onReact,
  onReply,
}: {
  message: Message;
  /** Transiently ringed when the user jumped here from a task source badge,
   *  and used for the *active* in-chat search match. */
  highlighted: boolean;
  /** A non-active in-chat search match — given a subtler highlight than the
   *  current match so all hits are visible while one is focused. */
  searchHit?: boolean;
  reactions: Array<{ emoji: string; direction: string }>;
  /** The original message this one replies to, if it's in the loaded thread. */
  quotedMessage?: Message;
  /** Tasks created from this specific message (heuristic match). */
  relatedTasks: ChatTask[];
  locale: string;
  /** When false, the react + reply buttons are hidden (24h window closed). */
  canReact: boolean;
  /** Called with this message's wamid and the selected emoji (or "" to
   *  remove). Takes the wamid as an argument so ThreadView can pass one
   *  stable handler to every bubble. */
  onReact: (wamid: string, emoji: string) => void;
  /** Start a reply quoting this message (WhatsApp Desktop UX). Takes the
   *  message as an argument for the same stable-handler reason. */
  onReply: (message: Message) => void;
}) {
  const t = useTranslations("whatsappPage");
  const isOutgoing = message.direction === "outgoing";

  // Reaction-picker visibility per bubble. Click the react button to
  // toggle. We close on outside click via a one-shot effect below.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  // The user's currently-active reaction on THIS message (so the picker
  // can highlight it, and clicking again removes it).
  const myReaction = reactions.find((r) => r.direction === "outgoing")?.emoji ?? null;

  // Images: render inline. Audio: render inline with a native <audio> player.
  // Other media (docs, etc.): fetch a fresh signed URL on click and open in
  // a new tab. We hold the signed URL in state so that for images the <img>
  // (and for audio the <audio>) has a real src and can render right away.
  const [imageSignedUrl, setImageSignedUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);

  const isImage = message.message_type === "image" && Boolean(message.media_url);
  const isAudio = (message.message_type === "audio" || message.message_type === "voice")
    && Boolean(message.media_url);

  // Signed URLs carry a ~1h TTL. In a chat left open longer than that, the
  // <img>/<audio> element errors on remount or first playback with no
  // refetch — silently dead media. On the element's error event we record the
  // dead URL and bump a nonce so the effect below skips it and mints a fresh
  // one via the /api/whatsapp/media fallback. The Set guards against error
  // loops: each distinct URL triggers at most one refetch, and the counter
  // caps total refetches per bubble (e.g. media object deleted from Storage,
  // where every freshly-minted URL would error again).
  const erroredUrlsRef = useRef<Set<string>>(new Set());
  const mediaErrorRetriesRef = useRef(0);
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const onMediaError = useCallback(() => {
    if (
      !imageSignedUrl ||
      erroredUrlsRef.current.has(imageSignedUrl) ||
      mediaErrorRetriesRef.current >= MEDIA_ERROR_RETRY_CAP
    ) {
      return;
    }
    erroredUrlsRef.current.add(imageSignedUrl);
    mediaErrorRetriesRef.current += 1;
    setImageSignedUrl(null);
    setMediaRetryNonce((n) => n + 1);
  }, [imageSignedUrl]);

  useEffect(() => {
    if ((!isImage && !isAudio) || !message.media_url) return;
    // Prefer the batch-minted URL the messages payload already carries — no
    // per-bubble round-trip. Rows without one (legacy full-URL media_url
    // values, batch-sign failure) — or whose batch URL already errored
    // (expired TTL) — fall back to the per-path fetch below.
    if (message.media_signed_url && !erroredUrlsRef.current.has(message.media_signed_url)) {
      setImageSignedUrl(message.media_signed_url);
      setImageLoading(false);
      return;
    }
    let cancelled = false;
    setImageLoading(true);
    api<{ url: string }>(
      `/api/whatsapp/media?path=${encodeURIComponent(message.media_url)}`,
    )
      .then(({ url }) => {
        if (!cancelled) setImageSignedUrl(url);
      })
      .catch((e) => {
        if (!cancelled) console.error("media signed URL failed:", e);
      })
      .finally(() => {
        if (!cancelled) setImageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, isAudio, message.media_url, message.media_signed_url, mediaRetryNonce]);

  async function openMedia() {
    if (!message.media_url) return;
    try {
      const { url } = await api<{ url: string }>(
        `/api/whatsapp/media?path=${encodeURIComponent(message.media_url)}`,
      );
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const ts = new Date(message.received_at);

  // Per-message direction: determined by the language of the user-typed
  // body, NOT by who sent it. Hebrew content sits on the right edge,
  // Latin content on the left. Color (green vs white) is what signals
  // outgoing vs incoming. We fall back to OCR/transcript when there's no
  // body so media-only messages still land on the right side of the
  // viewport when their content is Hebrew.
  const dirSource = message.body_text || message.audio_transcript || message.media_ocr_text || "";
  const msgDir = detectMessageDir(dirSource);
  const flexAlign = msgDir === "rtl" ? "justify-end" : "justify-start";

  return (
    <div className={`group flex flex-col ${flexAlign}`} data-wamid={message.wamid}>
      <div className={`relative flex items-center gap-1 ${flexAlign}`}>
        {/* React button — hidden by default, appears on hover. Placed on
            the OPPOSITE edge of the bubble's alignment so it doesn't crowd
            the content side. */}
        {canReact && msgDir === "rtl" && (
          <div className="flex shrink-0 items-center gap-0.5">
            <ReplyButton onReply={() => onReply(message)} label={t("reply")} />
            <ReactionButton
              myReaction={myReaction}
              pickerOpen={pickerOpen}
              pickerRef={pickerRef}
              onTogglePicker={() => setPickerOpen((v) => !v)}
              onPick={(emoji) => {
                setPickerOpen(false);
                onReact(message.wamid, emoji);
              }}
            />
          </div>
        )}
        <div
          dir={msgDir}
          className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm shadow-sm transition-shadow ${
            isOutgoing
              ? "bg-status-ok-bg text-foreground"
              : "bg-card text-foreground"
          } ${
            highlighted
              ? "ring-2 ring-primary ring-offset-2 ring-offset-muted"
              : searchHit
                ? "ring-1 ring-status-warn"
                : ""
          }`}
        >
        {message.from_name && !isOutgoing && (
          <p className="text-[11px] font-medium text-status-ok">{message.from_name}</p>
        )}

        {/* Reply quote — when this message is a reply to a previous one,
            mimic WhatsApp's stacked-quote UI with a left/right accent bar
            and a one-line preview of the original. */}
        {quotedMessage && (
          <div
            className={`mb-1.5 rounded border-s-4 bg-muted px-2 py-1 text-xs ${
              quotedMessage.direction === "outgoing"
                ? "border-status-ok"
                : "border-primary"
            }`}
            dir={detectMessageDir(quotedMessage.body_text)}
          >
            <p className="text-[10px] font-medium text-muted-foreground">
              {quotedMessage.direction === "outgoing"
                ? t("you")
                : quotedMessage.from_name?.trim() || quotedMessage.from_phone || t("contact")}
            </p>
            <p className="line-clamp-2 break-words text-[11px] text-muted-foreground/80">
              {quotedMessage.body_text?.slice(0, 200) || `[${quotedMessage.message_type}]`}
            </p>
          </div>
        )}

        {/* Image preview — render before the body so the picture is what
            the user sees first, with the OCR/caption as supplementary text. */}
        {isImage && (
          <div className="mt-1 mb-1.5">
            {imageSignedUrl ? (
              <button
                type="button"
                onClick={() => imageSignedUrl && window.open(imageSignedUrl, "_blank", "noopener")}
                className="block overflow-hidden rounded-md"
                aria-label={t("openDocument")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageSignedUrl}
                  alt=""
                  onError={onMediaError}
                  className="max-h-[280px] max-w-full rounded-md object-contain bg-muted"
                />
              </button>
            ) : imageLoading ? (
              <div className="h-32 w-48 animate-pulse rounded-md bg-muted" />
            ) : (
              <div className="h-32 w-48 rounded-md bg-muted" />
            )}
          </div>
        )}

        {/* Audio player — for voice memos / audio messages with a stored
            media_url, render a native <audio> control so the user can hit
            play and listen to the original. The transcript (rendered as an
            ExtractedBlock below) stays as the readable representation. */}
        {isAudio && (
          <div className="mt-1 mb-1.5 min-w-[220px]">
            {imageSignedUrl ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio
                controls
                preload="none"
                src={imageSignedUrl}
                onError={onMediaError}
                className="w-full max-w-xs"
              />
            ) : imageLoading ? (
              <div className="h-10 w-56 animate-pulse rounded-full bg-muted" />
            ) : (
              <div className="h-10 w-56 rounded-full bg-muted" />
            )}
          </div>
        )}

        {/* Body text — for an image with a caption this is the caption; for
            text messages it's the user's message. Rendered through the
            rich-text component so **bold** / *bold* / _italic_ / `code` /
            URLs / per-line direction all work as expected. */}
        {message.body_text && <RichMessageText text={message.body_text} />}

        {/* Image OCR — distinct framed sub-block so the user can tell it
            apart from the caption above. No "OCR:" label; the icon does it. */}
        {message.media_ocr_text && (
          <ExtractedBlock
            icon={<ScanText className="h-3 w-3" />}
            label={t("ocrLabel")}
            text={message.media_ocr_text}
          />
        )}

        {/* Audio transcript — same treatment. The bubble itself is the
            message; the transcript is decoration. */}
        {message.audio_transcript && (
          <ExtractedBlock
            icon={<Mic className="h-3 w-3" />}
            label={t("transcriptLabel")}
            text={message.audio_transcript}
          />
        )}

        {/* Other media (documents, etc.) keep the download-button UX. Image
            and audio render inline above; documents/PDFs stay download-only. */}
        {message.media_url && !isImage && !isAudio && (
          <button
            type="button"
            onClick={openMedia}
            className="mt-1.5 flex items-center gap-1.5 rounded border bg-card px-2 py-1 text-xs text-primary hover:bg-accent"
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="truncate max-w-[200px]">
              {message.media_filename ?? t("openDocument")}
            </span>
            <Download className="h-3 w-3 ms-auto" />
          </button>
        )}

        {/* Tasks created from this message (heuristic match by created_at) —
            small inline links per task so the user can jump from the
            conversation context straight to the resulting task card.
            Routing depends on the task's lifecycle:
              • not yet verified by the user  → /inbox (suggestion)
              • status='in_progress'          → /tasks?tab=active
              • status='archived'             → /tasks?tab=completed
              • else (verified inbox)         → /tasks (default Pending tab)
            ?focus=<id> tells the destination page which card to open. */}
        {relatedTasks.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {relatedTasks.map((task) => {
              const taskTitle =
                locale === "he" && task.title_he ? task.title_he : task.title ?? t("contact");
              const href = taskLinkFor(task, locale);
              const isSuggestion = task.manually_verified === false;
              return (
                <Link
                  key={task.id}
                  href={href}
                  className={`inline-flex items-center gap-1 self-start rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                    isSuggestion
                      ? "border-status-warn bg-status-warn-bg text-status-warn hover:bg-status-warn-bg/70"
                      : "border-primary bg-accent text-primary hover:bg-accent/70"
                  }`}
                  title={isSuggestion ? t("openSuggestion") : t("openTask")}
                >
                  <CheckSquare className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">
                    {isSuggestion ? `${t("suggestionPrefix")} ${taskTitle}` : taskTitle}
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span title={ts.toLocaleString(locale === "he" ? "he-IL" : "en-US", { dateStyle: "full", timeStyle: "short" })}>
            {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.is_history && (
            <span className="rounded bg-status-warn-bg px-1 text-status-warn">{t("history")}</span>
          )}
          {/* WhatsApp-style delivery ticks on outgoing only.
              sent      → single grey check
              delivered → double grey checks (CheckCheck)
              read      → double blue checks (CheckCheck colored)
              failed    → red alert icon.
              Note: DualHook's Webhook Override does not forward Meta's
              `statuses` events to us — they classify them as "operational
              monitoring" and keep them on their app-level callback.
              So today every outgoing message stays at "sent ✓" forever
              regardless of whether the recipient actually delivered/read
              it. The tooltip explains why so it's not surprising. */}
          {isOutgoing && <DeliveryReceipt status={message.status ?? null} pending={message.pending} t={t} />}
        </div>
        </div>
        {/* React button on the LTR side — same component, just rendered
            after the bubble so flex order puts it on the visual left. */}
        {canReact && msgDir === "ltr" && (
          <div className="flex shrink-0 items-center gap-0.5">
            <ReactionButton
              myReaction={myReaction}
              pickerOpen={pickerOpen}
              pickerRef={pickerRef}
              onTogglePicker={() => setPickerOpen((v) => !v)}
              onPick={(emoji) => {
                setPickerOpen(false);
                onReact(message.wamid, emoji);
              }}
            />
            <ReplyButton onReply={() => onReply(message)} label={t("reply")} />
          </div>
        )}
      </div>

      {/* Reactions — a compact pill UNDER the bubble (not inside it), the
          way WhatsApp renders them. We aggregate by emoji and show count. */}
      {reactions.length > 0 && (
        <div className={`mt-[-2px] flex ${flexAlign}`}>
          <div className="rounded-full border bg-card shadow-sm px-1.5 py-0.5 flex items-center gap-0.5 text-xs leading-none">
            {aggregateReactions(reactions).map(({ emoji, count }) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  // Tapping your own reaction removes it; tapping a peer's
                  // emoji applies the same emoji as YOUR reaction.
                  if (emoji === myReaction) onReact(message.wamid, "");
                  else onReact(message.wamid, emoji);
                }}
                className="inline-flex items-center gap-0.5 hover:bg-muted/60 rounded px-1 transition"
                title={t("reactWith", { emoji })}
              >
                <span className="text-sm">{emoji}</span>
                {count > 1 && <span className="text-[10px] text-muted-foreground">{count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
});

/**
 * Visual frame around AI-extracted content (image OCR or audio transcript).
 * Light tint + thin border + small icon — clearly distinct from the
 * primary message body without shouting.
 */
function ExtractedBlock({
  icon,
  label,
  text,
}: {
  icon: React.ReactNode;
  /** Used as the screen-reader label and a visible-on-hover title; the
   *  icon alone carries no semantics. */
  label: string;
  text: string;
}) {
  return (
    <div
      className="mt-1.5 rounded-md border border-border bg-muted px-2 py-1.5"
      role="group"
      aria-label={label}
    >
      <div
        className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70"
        title={label}
      >
        {icon}
        <span className="sr-only">{label}</span>
      </div>
      <RichMessageText text={text} className="text-[13px] text-foreground" />
    </div>
  );
}

/**
 * WhatsApp-style delivery indicator for outgoing messages.
 * - null / sent              → single grey check (Meta accepted the message)
 * - delivered                → double grey checks
 * - read                     → double blue checks
 * - failed                   → red alert
 *
 * Production caveat: DualHook (our BSP) currently does NOT forward
 * Meta's `statuses` webhook events to our override URL — only message
 * webhooks (incoming, echoes, history). As a result every outgoing
 * message stays at "sent ✓" indefinitely regardless of whether the
 * recipient actually delivered/read it. The single check still means
 * "Meta accepted the message" (we got a wamid back), which is more
 * meaningful than nothing. The tooltip on the icon explains the
 * limitation so the user isn't confused.
 */
function DeliveryReceipt({
  status,
  pending,
  t,
}: {
  status: Message["status"];
  /** Optimistic bubble not yet confirmed by Meta — show a clock. */
  pending?: boolean;
  t: (key: string) => string;
}) {
  if (pending) {
    return <Clock className="h-3.5 w-3.5 text-muted-foreground/70" aria-label="sending" />;
  }
  if (status === "failed") {
    return <AlertCircle className="h-3.5 w-3.5 text-status-late" aria-label="failed" />;
  }
  if (status === "read") {
    return <CheckCheck className="h-3.5 w-3.5 text-primary" aria-label="read" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" aria-label="delivered" />;
  }
  // sent or unknown.
  return (
    <span title={t("noReceiptsTooltip")}>
      <Check className="h-3.5 w-3.5 text-muted-foreground" aria-label="sent" />
    </span>
  );
}

/**
 * Format the "last seen" line in the chat header. Real WhatsApp
 * last-seen isn't exposed by the Cloud API; we approximate from the
 * most recent incoming message or read receipt.
 */
/**
 * Build the right href for a chat-task chip. Pending AI suggestions live
 * on /inbox; verified tasks live on /tasks under the correct status tab.
 * `?focus=<id>` tells the destination page to open the matching card.
 */
function taskLinkFor(task: ChatTask, locale: string): string {
  if (task.manually_verified === false) {
    return `/${locale}/inbox?focus=${task.id}`;
  }
  const status = task.status ?? "inbox";
  if (status === "in_progress")           return `/${locale}/tasks?tab=active&focus=${task.id}`;
  if (status === "archived" || status === "completed") {
    // Real completions live in the Completed tab. Dismissed tasks DON'T
    // — they have their own status now and aren't surfaced in any tab
    // by default. For those we fall through to the default Pending view
    // so the user lands somewhere coherent instead of an empty tab.
    return `/${locale}/tasks?tab=completed&focus=${task.id}`;
  }
  return `/${locale}/tasks?focus=${task.id}`;
}

/** Centered date pill between messages from different calendar days —
 *  WhatsApp's day-separator. */
function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-2">
      <span className="rounded-full bg-card/90 px-3 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}

/** Same calendar day in local time. */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Day-separator label: "Today" / "Yesterday" / weekday (last week) / full
 *  date (older). Mirrors WhatsApp's grouping. */
function formatDaySeparator(
  date: Date,
  locale: string,
  t: (key: string, vals?: Record<string, string | number>) => string,
): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diffDays === 0) return t("dateToday");
  if (diffDays === 1) return t("dateYesterday");
  const loc = locale === "he" ? "he-IL" : "en-US";
  if (diffDays > 1 && diffDays < 7) return date.toLocaleDateString(loc, { weekday: "long" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(loc, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatLastSeen(date: Date, t: (key: string, vals?: Record<string, string | number>) => string): string {
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 5) return t("activeNow");
  if (min < 60) return t("activeMinutesAgo", { count: min });
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return t("activeHoursAgo", { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 7) return t("activeDaysAgo", { count: days });
  return t("activeOnDate", { date: date.toLocaleDateString() });
}

/**
 * The compact smiley button + quick-react palette popover that floats
 * alongside each message bubble. WhatsApp Web shows this on hover; we
 * keep the same UX but make the button always discoverable on mobile
 * (where there's no hover).
 */
function ReactionButton({
  myReaction,
  pickerOpen,
  pickerRef,
  onTogglePicker,
  onPick,
}: {
  myReaction: string | null;
  pickerOpen: boolean;
  pickerRef: React.MutableRefObject<HTMLDivElement | null>;
  onTogglePicker: () => void;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="relative shrink-0" ref={pickerRef}>
      <button
        type="button"
        onClick={onTogglePicker}
        className="opacity-0 group-hover:opacity-100 touch:opacity-100 transition rounded-full p-1 hover:bg-muted/60"
        aria-label="React"
      >
        <SmilePlus className="h-4 w-4 text-muted-foreground" />
      </button>
      {pickerOpen && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-10 rounded-full border bg-card shadow-lg px-1 py-1 flex gap-0.5">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e === myReaction ? "" : e)}
              className={`text-lg leading-none rounded-full w-8 h-8 flex items-center justify-center transition ${
                e === myReaction ? "bg-status-ok-bg scale-110" : "hover:bg-muted/60"
              }`}
              title={e}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact reply button that floats alongside each message bubble, mirroring
 * WhatsApp Desktop's hover affordance. Tapping it lifts the message into the
 * composer as a quote. Always rendered (discoverable on mobile where there's
 * no hover) but only visible on hover on desktop, matching ReactionButton.
 */
function ReplyButton({ onReply, label }: { onReply: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onReply}
      className="opacity-0 group-hover:opacity-100 touch:opacity-100 transition rounded-full p-1 hover:bg-muted/60"
      aria-label={label}
      title={label}
    >
      <Reply className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

/**
 * Group an array of `{ emoji, direction }` into `{ emoji, count }` —
 * one entry per unique emoji. Order: most-recently-added first
 * (so a fresh reaction sits at the start of the pill).
 */
function aggregateReactions(
  reactions: Array<{ emoji: string; direction: string }>,
): Array<{ emoji: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of reactions) {
    if (!r.emoji) continue;
    counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  }
  return [...counts.entries()].map(([emoji, count]) => ({ emoji, count }));
}
