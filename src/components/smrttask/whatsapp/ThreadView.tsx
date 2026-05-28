"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, Check, CheckCheck, AlertCircle, Loader2, FileText, Download, Send, SmilePlus, CheckSquare, Mic, MicOff, Sparkles, X, ScanText, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  reply_to_wamid: string | null;
  reaction_emoji: string | null;
  is_reaction: boolean;
  is_history: boolean;
  history_phase: number | null;
  received_at: string;
  // Read/delivery receipts — only populated for outgoing messages once
  // Meta sends us the corresponding `statuses` webhook event.
  status?: "sent" | "delivered" | "read" | "failed" | null;
  status_error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
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
  /** Called after a successful send so the parent can refetch immediately. */
  onMessageSent?: () => void;
  /** Called after the user renames the contact so the parent can refresh
   *  the thread list (so the new name appears in the left pane too). */
  onContactRenamed?: () => void;
}

const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export function ThreadView({ messages, tasks, loading, chatId, thread, locale, onBack, onMessageSent, onContactRenamed }: Props) {
  const t = useTranslations("whatsappPage");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Snap to bottom on initial load and when new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Build a lookup for reactions: target_wamid → reaction emojis.
  // We keep at most one reaction per direction (matches WhatsApp UX:
  // each side can leave one emoji per message; later reactions replace).
  const reactionsByTarget = new Map<string, Array<{ emoji: string; direction: string }>>();
  for (const m of messages) {
    if (m.is_reaction && m.reply_to_wamid && m.reaction_emoji) {
      const list = reactionsByTarget.get(m.reply_to_wamid) ?? [];
      // Replace earlier reactions from the same direction; keeps the latest.
      const filtered = list.filter((r) => r.direction !== m.direction);
      filtered.push({ emoji: m.reaction_emoji, direction: m.direction });
      reactionsByTarget.set(m.reply_to_wamid, filtered);
    }
  }

  const visibleMessages = messages.filter((m) => !m.is_reaction);

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
    for (const m of messages) map.set(m.wamid, m);
    return map;
  }, [messages]);

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
    <div className="flex h-full flex-col rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b bg-muted/40 p-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label={t("back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
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
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => void submitRename()}
                disabled={renameSaving}
                aria-label={t("renameContactSave")}
                title={t("renameContactSave")}
              >
                {renameSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setRenaming(false)}
                disabled={renameSaving}
                aria-label={t("renameContactCancel")}
                title={t("renameContactCancel")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <p className="font-medium text-sm truncate">{displayName}</p>
              <button
                type="button"
                onClick={startRename}
                className="text-muted-foreground hover:text-foreground p-0.5 shrink-0"
                aria-label={t("renameContact")}
                title={t("renameContact")}
              >
                <Pencil className="h-3 w-3" />
              </button>
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
      </div>

      {/* Messages — force LTR on the container so the per-message
          alignment logic below stays consistent regardless of the app's
          interface locale. Each bubble's own `dir` is set based on the
          language of its body_text. */}
      <div
        ref={scrollRef}
        dir="ltr"
        className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-[#f0f2f5]"
      >
        {visibleMessages.length === 0 && !loading && (
          <p className="text-center text-sm text-muted-foreground py-8">{t("emptyChat")}</p>
        )}
        {visibleMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            reactions={reactionsByTarget.get(m.wamid) ?? []}
            quotedMessage={m.reply_to_wamid ? messagesByWamid.get(m.reply_to_wamid) : undefined}
            relatedTasks={tasksByMessageId.get(m.id) ?? []}
            locale={locale}
            canReact={withinWindow}
            onReact={async (emoji) => {
              try {
                await api("/api/whatsapp/messages/react", {
                  method: "POST",
                  body: { target_wamid: m.wamid, emoji },
                });
                onMessageSent?.();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        ))}
      </div>

      {/* Compose box — Meta only allows free-form replies within 24h of the
          customer's last message. Outside the window, the input is disabled
          and we explain why. */}
      <ComposeBox
        chatId={chatId}
        withinWindow={withinWindow}
        windowExpiresAt={windowExpiresAt}
        onSent={onMessageSent}
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
  onSent,
}: {
  chatId: string;
  withinWindow: boolean;
  windowExpiresAt: Date | null;
  onSent?: () => void;
}) {
  const t = useTranslations("whatsappPage");
  const searchParams = useSearchParams();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

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

  // Voice recording state. We only spin up MediaRecorder when the user
  // taps the mic button (and the browser supports it) — no eager
  // getUserMedia prompt.
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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
      const arrayBuf = await blob.arrayBuffer();
      // Browser-safe base64 encode of binary data (chunked to avoid
      // call-stack overflow on long recordings).
      let binary = "";
      const bytes = new Uint8Array(arrayBuf);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const base64 = btoa(binary);

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
    // Drop the textarea + suggestion immediately so the operator can
    // start typing the next message while Meta's send call (~1-2s)
    // finishes in the background.
    setText("");
    setSuggestion(null);
    setEnglishApproved(false);
    lastCheckedRef.current = "";
    setSending(true);
    try {
      await api("/api/whatsapp/messages/send", {
        method: "POST",
        body: { to_phone: chatId, text: trimmed },
      });
      onSent?.();
    } catch (e) {
      // Only the textarea-driven send restores the draft; accepting a
      // suggestion already wiped the original, restoring it would feel
      // surprising.
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

  async function handleSend() {
    await sendMessage(text, { restoreOnFail: true });
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
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
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
        <div className="rounded border border-blue-200 bg-blue-50 p-2 space-y-1.5" dir="ltr">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-blue-700">
            <Sparkles className="h-3 w-3" />
            <span>{t("englishSuggestion")}</span>
          </div>
          <p className="text-sm text-blue-950 whitespace-pre-wrap break-words">{suggestion}</p>
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

      {/* Recording / transcribing status line. Shows while either is
          active so the user knows what's happening. */}
      {(recording || transcribing) && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
          {recording && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              {t("recording")}
            </>
          )}
          {transcribing && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("transcribing")}
            </>
          )}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <Button
          type="button"
          size="icon"
          variant={recording ? "destructive" : "outline"}
          disabled={!withinWindow || transcribing}
          onClick={recording ? stopRecording : startRecording}
          aria-label={recording ? t("stopRecording") : t("startRecording")}
          title={recording ? t("stopRecording") : t("startRecording")}
        >
          {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={withinWindow ? t("composePlaceholder") : t("composeDisabled")}
          disabled={!withinWindow || transcribing}
          dir={dir}
          rows={1}
          className="resize-none min-h-[40px] max-h-[140px] text-sm"
        />
        <Button
          type="button"
          onClick={handleSend}
          disabled={!withinWindow || !text.trim()}
          size="icon"
          aria-label={t("send")}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
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
        <p className="text-[10px] text-green-700 flex items-center gap-1">
          <Check className="h-2.5 w-2.5" />
          {t("englishApproved")}
        </p>
      )}
    </div>
  );
}

/** Quick-react palette — the same six emojis WhatsApp Web shows by default. */
const QUICK_EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"] as const;

function MessageBubble({
  message,
  reactions,
  quotedMessage,
  relatedTasks,
  locale,
  canReact,
  onReact,
}: {
  message: Message;
  reactions: Array<{ emoji: string; direction: string }>;
  /** The original message this one replies to, if it's in the loaded thread. */
  quotedMessage?: Message;
  /** Tasks created from this specific message (heuristic match). */
  relatedTasks: ChatTask[];
  locale: string;
  /** When false, the react button is hidden (24h window closed). */
  canReact: boolean;
  /** Called with the selected emoji (or "" to remove). */
  onReact: (emoji: string) => void;
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

  useEffect(() => {
    if ((!isImage && !isAudio) || !message.media_url) return;
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
  }, [isImage, isAudio, message.media_url]);

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
    <div className={`group flex flex-col ${flexAlign}`}>
      <div className={`relative flex items-center gap-1 ${flexAlign}`}>
        {/* React button — hidden by default, appears on hover. Placed on
            the OPPOSITE edge of the bubble's alignment so it doesn't crowd
            the content side. */}
        {canReact && msgDir === "rtl" && (
          <ReactionButton
            myReaction={myReaction}
            pickerOpen={pickerOpen}
            pickerRef={pickerRef}
            onTogglePicker={() => setPickerOpen((v) => !v)}
            onPick={(emoji) => {
              setPickerOpen(false);
              onReact(emoji);
            }}
          />
        )}
        <div
          dir={msgDir}
          className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm shadow-sm ${
            isOutgoing
              ? "bg-emerald-100 text-emerald-950"
              : "bg-white text-gray-900"
          }`}
        >
        {message.from_name && !isOutgoing && (
          <p className="text-[11px] font-medium text-emerald-700">{message.from_name}</p>
        )}

        {/* Reply quote — when this message is a reply to a previous one,
            mimic WhatsApp's stacked-quote UI with a left/right accent bar
            and a one-line preview of the original. */}
        {quotedMessage && (
          <div
            className={`mb-1.5 rounded border-s-4 bg-black/[0.04] px-2 py-1 text-xs ${
              quotedMessage.direction === "outgoing"
                ? "border-emerald-500"
                : "border-blue-500"
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
                  className="max-h-[280px] max-w-full rounded-md object-contain bg-black/5"
                />
              </button>
            ) : imageLoading ? (
              <div className="h-32 w-48 animate-pulse rounded-md bg-black/10" />
            ) : (
              <div className="h-32 w-48 rounded-md bg-black/10" />
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
                className="w-full max-w-xs"
              />
            ) : imageLoading ? (
              <div className="h-10 w-56 animate-pulse rounded-full bg-black/10" />
            ) : (
              <div className="h-10 w-56 rounded-full bg-black/10" />
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
            className="mt-1.5 flex items-center gap-1.5 rounded border bg-white/70 px-2 py-1 text-xs text-blue-700 hover:bg-white"
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
                      ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                      : "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
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

        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-500">
          <span>
            {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {message.is_history && (
            <span className="rounded bg-amber-100 px-1 text-amber-700">{t("history")}</span>
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
          {isOutgoing && <DeliveryReceipt status={message.status ?? null} t={t} />}
        </div>
        </div>
        {/* React button on the LTR side — same component, just rendered
            after the bubble so flex order puts it on the visual left. */}
        {canReact && msgDir === "ltr" && (
          <ReactionButton
            myReaction={myReaction}
            pickerOpen={pickerOpen}
            pickerRef={pickerRef}
            onTogglePicker={() => setPickerOpen((v) => !v)}
            onPick={(emoji) => {
              setPickerOpen(false);
              onReact(emoji);
            }}
          />
        )}
      </div>

      {/* Reactions — a compact pill UNDER the bubble (not inside it), the
          way WhatsApp renders them. We aggregate by emoji and show count. */}
      {reactions.length > 0 && (
        <div className={`mt-[-2px] flex ${flexAlign}`}>
          <div className="rounded-full border bg-white shadow-sm px-1.5 py-0.5 flex items-center gap-0.5 text-xs leading-none">
            {aggregateReactions(reactions).map(({ emoji, count }) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  // Tapping your own reaction removes it; tapping a peer's
                  // emoji applies the same emoji as YOUR reaction.
                  if (emoji === myReaction) onReact("");
                  else onReact(emoji);
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
}

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
      className="mt-1.5 rounded-md border border-black/10 bg-black/[0.03] px-2 py-1.5"
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
      <RichMessageText text={text} className="text-[13px] text-gray-700" />
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
  t,
}: {
  status: Message["status"];
  t: (key: string) => string;
}) {
  if (status === "failed") {
    return <AlertCircle className="h-3.5 w-3.5 text-red-500" aria-label="failed" />;
  }
  if (status === "read") {
    return <CheckCheck className="h-3.5 w-3.5 text-blue-500" aria-label="read" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="h-3.5 w-3.5 text-gray-400" aria-label="delivered" />;
  }
  // sent or unknown.
  return (
    <span title={t("noReceiptsTooltip")}>
      <Check className="h-3.5 w-3.5 text-gray-400" aria-label="sent" />
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
        className="opacity-0 group-hover:opacity-100 transition rounded-full p-1 hover:bg-muted/60"
        aria-label="React"
      >
        <SmilePlus className="h-4 w-4 text-muted-foreground" />
      </button>
      {pickerOpen && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-10 rounded-full border bg-white shadow-lg px-1 py-1 flex gap-0.5">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e === myReaction ? "" : e)}
              className={`text-lg leading-none rounded-full w-8 h-8 flex items-center justify-center transition ${
                e === myReaction ? "bg-emerald-100 scale-110" : "hover:bg-muted/60"
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
