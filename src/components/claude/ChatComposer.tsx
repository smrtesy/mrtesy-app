"use client";

/**
 * The composer — one row: type, attach, dictate, send.
 *
 * Deliberately four controls and nothing else. Everything that configures the
 * conversation (working method, repo, model, effort, standing instructions) lives
 * behind the header's settings button, not here — a composer that grows a toolbar
 * stops being a place to type.
 *
 * Enter sends, Shift+Enter makes a newline — on a physical keyboard (desktop). On
 * touch devices (phones/tablets) Enter just drops a newline and ONLY the Send
 * button sends, because on a phone the on-screen return key is how you make a new
 * line and there's no Shift to hold. The mic is icon-only: it sits beside Send and
 * a word there would be permanent chrome.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { DictationButton } from "./DictationButton";

/** Mirrors the bucket's own limit (25 MB) so the file is rejected here rather than
 *  after a slow upload. */
// 7MB, not the bucket's 25MB: uploads are base64 inside a JSON body and the global
// express.json limit is 10mb, so anything larger is rejected by the body parser
// before any handler sees it. Promising 25MB here would be a lie the user only
// discovers as an opaque error.
const MAX_FILE_BYTES = 7 * 1024 * 1024;
// Grow the input generously so a long message is visible without scrolling inside
// the box (the request: "always show everything I write"). It still caps before it
// could push the conversation off screen, then scrolls.
const MAX_ROWS_PX = 360;
/** ~3 lines: the box starts tall, like Claude Code, not a single cramped row. */
const MIN_ROWS_PX = 76;

// Per-thread draft. What you typed and didn't send stays tied to THIS chat:
// switching chats loads that chat's draft (or an empty box), sending clears it.
// Kept in localStorage (survives a page refresh, mirrors how Claude Code keeps
// drafts) keyed by thread id — "new" before the thread exists; ClaudeChat carries
// that "new" draft onto the real id the moment ensureThread mints one.
const DRAFT_PREFIX = "claude:draft:";
const draftKey = (id: string | null) => `${DRAFT_PREFIX}${id ?? "new"}`;

export interface StagedAttachment {
  id: string;
  filename: string;
  size_bytes: number | null;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function ChatComposer({
  threadId,
  ensureThread,
  busy,
  running,
  seedText,
  onSend,
  onStop,
  models,
  model,
  onModelChange,
  efforts,
  effort,
  onEffortChange,
  effortDefaultValue,
}: {
  /** Null until a thread exists. Used only to decide whether one has to be created
   *  before an upload can be addressed to it. */
  threadId: string | null;
  /** Creates the thread if there isn't one yet and returns its id. Attaching a file
   *  to a brand-new chat has to work — waiting for the first message to be sent
   *  would mean you cannot open a conversation WITH a screenshot, which is one of
   *  the most common ways to start one. */
  ensureThread: () => Promise<string | null>;
  /** A send round-trip is in flight — the ONLY state that blocks sending (it
   *  prevents a double-submit of the same text). */
  busy: boolean;
  /** A turn is actually executing. Sending stays OPEN (the message queues behind
   *  the live turn, like typing in Claude Code mid-run) — this only adds the Stop
   *  button beside Send. */
  running: boolean;
  /** Prefills the input once (the inspect-mode seed). The user completes the
   *  message and sends; typing afterwards is theirs, so it is applied only while
   *  the input is empty. */
  seedText?: string | null;
  onSend: (message: string, attachmentIds: string[]) => Promise<void> | void;
  onStop: () => void;
  /** Model + effort live in the toolbar under the input, like Claude Code, so the
   *  per-turn choice sits where you type instead of behind the settings button. */
  models: ReadonlyArray<{ id: string; name: string }>;
  model: string;
  onModelChange: (id: string) => void;
  efforts: ReadonlyArray<string>;
  /** The current effort, or `effortDefaultValue` when the thread lets the engine
   *  pick — the Select never holds an empty string, which Radix forbids. */
  effort: string;
  onEffortChange: (value: string) => void;
  effortDefaultValue: string;
}) {
  const t = useTranslations("claudeChat");
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Touch devices (coarse primary pointer) get newline-on-Enter; only the Send
  // button sends. Resolved on the client after mount — SSR defaults to false, so
  // desktop's Enter-to-send is the pre-hydration behavior.
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(window.matchMedia?.("(pointer: coarse)").matches ?? false);
  }, []);

  // Which chat the current `text` belongs to. `undefined` until the load effect
  // has run once, so the save effect below can't persist an empty initial render
  // over a real stored draft.
  const loadedForRef = useRef<string | null | undefined>(undefined);

  // Load this chat's draft into the box when the active chat changes (and on
  // mount). Placed BEFORE the seed effect so a stored draft is never clobbered by
  // a seed (the seed's functional update sees the just-loaded text and stands down
  // when it is non-empty).
  useEffect(() => {
    const id = threadId ?? null;
    if (loadedForRef.current === id) return;
    loadedForRef.current = id;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(draftKey(id));
    } catch {
      /* storage unavailable — fall back to an empty box */
    }
    setText(saved ?? "");
  }, [threadId]);

  // Persist the box to the active chat's draft as it changes. Guarded on the load
  // effect having run (loadedForRef set), so the first empty render can't wipe a
  // saved draft, and keyed off loadedForRef — not threadId — so a chat switch
  // writes under the chat the text actually belongs to, never the one just left.
  useEffect(() => {
    const id = loadedForRef.current;
    if (id === undefined) return;
    try {
      if (text) localStorage.setItem(draftKey(id), text);
      else localStorage.removeItem(draftKey(id));
    } catch {
      /* storage full / blocked — a lost draft is acceptable, a crash is not */
    }
  }, [text]);

  // The inspect-mode seed lands in the input ready to complete. Only while the
  // input is empty — a seed must never overwrite something the user typed.
  useEffect(() => {
    if (!seedText) return;
    setText((current) => current.trim() ? current : seedText);
    areaRef.current?.focus();
  }, [seedText]);

  // Grow with the content between a tall floor and a ceiling, then scroll — so
  // everything typed stays visible, but the box can't push the conversation off the
  // screen. Clamping to MIN keeps the resting height stable while the field is empty.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_ROWS_PX), MAX_ROWS_PX)}px`;
  }, [text]);

  const send = useCallback(async () => {
    const message = text.trim();
    if ((!message && staged.length === 0) || busy) return;
    const sentStaged = staged;
    const draftId = loadedForRef.current ?? null;
    // Cleared before awaiting so a second Enter cannot double-send — but PUT BACK
    // if the send fails. Losing what the user typed to a dropped connection or a
    // 409 is the worst outcome here; the attachment ids are unrecoverable once the
    // chips are gone.
    setText("");
    setStaged([]);
    // Drop the draft synchronously — before onSend()→ensureThread can migrate a
    // "new" draft onto the fresh id — so a just-sent message never reappears.
    try {
      localStorage.removeItem(draftKey(draftId));
    } catch {
      /* storage unavailable */
    }
    try {
      await onSend(message, sentStaged.map((x) => x.id));
    } catch {
      setText((current) => (current ? current : message));
      setStaged((current) => (current.length > 0 ? current : sentStaged));
    }
  }, [text, staged, busy, onSend]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const id = threadId ?? (await ensureThread());
    if (!id) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_BYTES) {
          toast.error(t("fileTooLarge", { name: file.name }));
          continue;
        }
        const { attachment } = await api<{ attachment: StagedAttachment }>(
          `/api/claude/threads/${id}/attachments`,
          {
            method: "POST",
            body: {
              filename: file.name,
              mime_type: file.type || null,
              base64: await fileToBase64(file),
            },
          },
        );
        setStaged((prev) => [...prev, attachment]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const canSend = (text.trim() !== "" || staged.length > 0) && !busy;

  return (
    <div className="border-t bg-background p-2">
      {staged.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {staged.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px]"
            >
              <span className="max-w-40 truncate">{a.filename}</span>
              <button
                type="button"
                onClick={() => setStaged((prev) => prev.filter((s) => s.id !== a.id))}
                aria-label={t("removeAttachment")}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* One card: the input on top, a quiet toolbar underneath — the Claude Code
          layout. The border lives on the card (not the textarea) so the toolbar
          reads as part of the same field. */}
      <div className="rounded-xl border bg-background focus-within:ring-1 focus-within:ring-ring">
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // On touch devices Enter is a plain newline — only the Send button
            // sends. Skip all the Enter handling below so the textarea's default
            // (insert newline) runs.
            if (isTouch && e.key === "Enter") return;
            // isComposing checked so an IME's confirmation Enter doesn't send a
            // half-typed word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
              return;
            }
            // Shift+Enter continues a numbered/bulleted list automatically — the
            // next marker ("2. ", "- ") appears on the new line instead of the
            // user typing it. Empty item + Shift+Enter ends the list (drops the
            // dangling marker), the editor convention.
            if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) {
              const el = areaRef.current;
              if (!el || el.selectionStart !== el.selectionEnd) return; // caret only
              const pos = el.selectionStart;
              const before = text.slice(0, pos);
              const lineStart = before.lastIndexOf("\n") + 1;
              const line = before.slice(lineStart);
              const numbered = line.match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
              const bullet = line.match(/^(\s*)([-*])(\s+)(.*)$/);
              let marker: string | null = null;
              let itemEmpty = false;
              if (numbered) {
                itemEmpty = numbered[5].trim() === "";
                marker = `${numbered[1]}${parseInt(numbered[2], 10) + 1}${numbered[3]}${numbered[4]}`;
              } else if (bullet) {
                itemEmpty = bullet[4].trim() === "";
                marker = `${bullet[1]}${bullet[2]}${bullet[3]}`;
              }
              if (marker === null) return; // not a list line → plain newline
              // Only continue/end the list when the caret sits at the line's end.
              // Mid-item ("2. |extra") falls through to a plain newline — otherwise
              // `line` (text before the caret only) would misread the item as empty
              // and merge the trailing text upward, losing it.
              const rest = text.slice(pos);
              const nl = rest.indexOf("\n");
              if ((nl === -1 ? rest : rest.slice(0, nl)).trim() !== "") return;
              e.preventDefault();
              if (itemEmpty) {
                // The user pressed on an empty marker — end the list.
                const next = text.slice(0, lineStart) + text.slice(pos);
                setText(next);
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = lineStart;
                });
                return;
              }
              const insert = `\n${marker}`;
              const next = text.slice(0, pos) + insert + text.slice(pos);
              setText(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = pos + insert.length;
              });
            }
          }}
          onPaste={(e) => {
            // Pasting a screenshot is how most images arrive; without this the
            // paperclip would be the only way in.
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
              e.preventDefault();
              void upload(files);
            }
          }}
          rows={3}
          dir="auto"
          placeholder={t("placeholder")}
          className="block max-h-[360px] min-h-[76px] w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none"
        />

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />

        {/* Toolbar: model + effort on the leading edge (like Claude Code's
            "Opus / High"), the actions on the trailing edge. */}
        <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5">
          <div className="flex min-w-0 items-center gap-0.5">
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger
                className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
                aria-label={t("modelLabel")}
              >
                {/* Only the friendly name in the chip — the full id still shows in
                    the open list, so what runs stays visible without crowding here. */}
                <span className="truncate">
                  {models.find((m) => m.id === model)?.name ?? model}
                </span>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-center gap-2">
                      <span>{m.name}</span>
                      <span dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                        {m.id}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={effort} onValueChange={onEffortChange}>
              <SelectTrigger
                className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
                aria-label={t("effortLabel")}
              >
                <span className="truncate">
                  {effort === effortDefaultValue ? t("effortDefault") : t(`effort.${effort}`)}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={effortDefaultValue}>{t("effortDefault")}</SelectItem>
                {efforts.map((e) => (
                  <SelectItem key={e} value={e}>
                    {t(`effort.${e}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              aria-label={t("attach")}
              title={t("attach")}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            </Button>

            <DictationButton
              iconOnly
              className="h-8 w-8"
              onText={(v) => setText((p) => (p.trim() ? `${p.trim()} ${v}` : v))}
            />

            {/* Stop appears BESIDE Send while a turn runs — it does not replace it.
                Sending mid-run queues the message behind the live turn (like typing
                in Claude Code), so both actions stay one click away. */}
            {running && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-8 w-8 p-0"
                onClick={onStop}
                aria-label={t("stop")}
                title={t("stop")}
              >
                <Square className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className={cn("h-8 w-8 p-0")}
              disabled={!canSend}
              onClick={() => void send()}
              aria-label={running ? t("queueSend") : t("send")}
              title={running ? t("queueSend") : t("send")}
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
