"use client";

/**
 * The composer — one row: type, attach, dictate, send.
 *
 * Deliberately four controls and nothing else. Everything that configures the
 * conversation (working method, repo, model, effort, standing instructions) lives
 * behind the header's settings button, not here — a composer that grows a toolbar
 * stops being a place to type.
 *
 * Enter sends, Shift+Enter makes a newline. The mic is icon-only: it sits beside
 * Send and a word there would be permanent chrome.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { DictationButton } from "./DictationButton";

/** Mirrors the bucket's own limit (25 MB) so the file is rejected here rather than
 *  after a slow upload. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ROWS_PX = 200;

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
  onSend,
  onStop,
}: {
  /** Null until a thread exists. Used only to decide whether one has to be created
   *  before an upload can be addressed to it. */
  threadId: string | null;
  /** Creates the thread if there isn't one yet and returns its id. Attaching a file
   *  to a brand-new chat has to work — waiting for the first message to be sent
   *  would mean you cannot open a conversation WITH a screenshot, which is one of
   *  the most common ways to start one. */
  ensureThread: () => Promise<string | null>;
  /** A turn is in flight — Send becomes Stop. */
  busy: boolean;
  onSend: (message: string, attachmentIds: string[]) => Promise<void> | void;
  onStop: () => void;
}) {
  const t = useTranslations("claudeChat");
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Grow with the content up to a ceiling, then scroll — a composer that grows
  // without limit pushes the conversation off the screen.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const send = useCallback(async () => {
    const message = text.trim();
    if ((!message && staged.length === 0) || busy) return;
    // Cleared before awaiting, so a slow round trip can't be double-sent by a
    // second Enter — and restored by the caller's error toast if it fails.
    setText("");
    setStaged([]);
    await onSend(message, staged.map((s) => s.id));
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

      <div className="flex items-end gap-1">
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing checked so an IME's confirmation Enter doesn't send a
            // half-typed word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
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
          rows={1}
          dir="auto"
          placeholder={t("placeholder")}
          className="max-h-[200px] min-h-9 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-9 w-9 p-0"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          aria-label={t("attach")}
          title={t("attach")}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
        </Button>

        <DictationButton iconOnly onText={(v) => setText((p) => (p.trim() ? `${p.trim()} ${v}` : v))} />

        {busy ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-9 w-9 p-0"
            onClick={onStop}
            aria-label={t("stop")}
            title={t("stop")}
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className={cn("h-9 w-9 p-0")}
            disabled={!canSend}
            onClick={() => void send()}
            aria-label={t("send")}
            title={t("send")}
          >
            <Send className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
