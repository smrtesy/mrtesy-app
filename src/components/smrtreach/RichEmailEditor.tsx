"use client";

import { useCallback, useEffect, useRef } from "react";
import type { useTranslations } from "next-intl";
import { Bold, Italic, Underline, List, ListOrdered, Link2, RemoveFormatting, Braces } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Email body font stack — must stay in sync with EMAIL_FONT_STACK in
 * server/src/modules/smrtreach/send-service.ts. Applying the same face/size/
 * line-height here as the send pipeline makes this editor a faithful preview
 * of the delivered email (matching font and line spacing).
 */
export const EMAIL_FONT_STACK =
  "'Google Sans','Product Sans',Roboto,'Helvetica Neue',Arial,sans-serif";
export const DEFAULT_EMAIL_FONT_SIZE = 14;

export interface MergeFields {
  standard: string[];
  custom: string[];
}

interface RichEmailEditorProps {
  /** Current HTML body. */
  value: string;
  /** Called with the new HTML on every edit. */
  onChange: (html: string) => void;
  /** Available merge variables for the field-insertion dropdown. */
  fields: MergeFields;
  /** Body font size in px — mirrors what the sent email uses. */
  fontSize?: number;
  t: ReturnType<typeof useTranslations>;
}

/**
 * Dependency-free rich-text editor for the smrtReach email body.
 *
 * Produces HTML directly (the send pipeline already treats html_body as raw
 * HTML), so a contentEditable surface + a compact formatting toolbar is the
 * natural fit and avoids pulling in a heavy WYSIWYG dependency. The "fields"
 * dropdown inserts merge tokens in the exact {{var}} / {{custom.field}} format
 * the send-time render() understands, so what the user picks is what resolves.
 */
export function RichEmailEditor({ value, onChange, fields, fontSize, t }: RichEmailEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  // The selection inside the editor, saved whenever it changes. The fields
  // dropdown (Radix) steals focus when opened, collapsing the live selection,
  // so we restore this range before inserting a token.
  const savedRange = useRef<Range | null>(null);

  // Sync external value → DOM only when it actually differs, so React state
  // updates (e.g. a reset/load) reflect without clobbering the caret mid-typing.
  useEffect(() => {
    const el = editorRef.current;
    if (el && el.innerHTML !== value) el.innerHTML = value ?? "";
  }, [value]);

  const emitChange = useCallback(() => {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }, [onChange]);

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (editorRef.current?.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
    }
  }, []);

  // Run a formatting command on the live selection. mouseDown is suppressed by
  // the caller so the editor keeps focus and the selection stays intact.
  const exec = useCallback(
    (command: string, arg?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, arg);
      emitChange();
    },
    [emitChange],
  );

  const onLink = useCallback(() => {
    const url = window.prompt(t("toolbar.linkPrompt"))?.trim();
    if (!url) return;
    // Only allow safe schemes — keep javascript:/data: out of authored links.
    if (!/^(https?:|mailto:)/i.test(url)) return;
    exec("createLink", url);
  }, [exec, t]);

  const insertToken = useCallback(
    (token: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      // Restore the caret we saved before the dropdown grabbed focus.
      if (savedRange.current) {
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      }
      let range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (!range || !el.contains(range.commonAncestorContainer)) {
        // No usable caret (never focused) → append at the end.
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const node = document.createTextNode(token);
      range.insertNode(node);
      // Place the caret right after the inserted token.
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRange.current = range.cloneRange();
      emitChange();
    },
    [emitChange],
  );

  const standardLabel = (key: string) =>
    t(`field.${key}` as Parameters<typeof t>[0]);

  return (
    <div className="rounded-md border">
      {/* Toolbar — quiet icon buttons; identity revealed on hover. */}
      <div className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1">
        <IconButton label={t("toolbar.bold")} onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}>
          <Bold />
        </IconButton>
        <IconButton label={t("toolbar.italic")} onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}>
          <Italic />
        </IconButton>
        <IconButton label={t("toolbar.underline")} onMouseDown={(e) => { e.preventDefault(); exec("underline"); }}>
          <Underline />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton label={t("toolbar.bulletList")} onMouseDown={(e) => { e.preventDefault(); exec("insertUnorderedList"); }}>
          <List />
        </IconButton>
        <IconButton label={t("toolbar.numberList")} onMouseDown={(e) => { e.preventDefault(); exec("insertOrderedList"); }}>
          <ListOrdered />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton label={t("toolbar.link")} color="blue" onMouseDown={(e) => { e.preventDefault(); saveSelection(); }} onClick={onLink}>
          <Link2 />
        </IconButton>
        <IconButton label={t("toolbar.clearFormat")} onMouseDown={(e) => { e.preventDefault(); exec("removeFormat"); }}>
          <RemoveFormatting />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-border" />
        {/* Field-insertion dropdown — the "list of all field names". */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // Save the caret before Radix moves focus to the menu.
              onMouseDown={saveSelection}
              className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-8"
            >
              <Braces className="size-4" />
              {t("insertField")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-56">
            <DropdownMenuLabel>{t("fieldsStandard")}</DropdownMenuLabel>
            {fields.standard.map((key) => (
              <DropdownMenuItem key={key} onSelect={() => insertToken(`{{${key}}}`)}>
                <span className="flex-1">{standardLabel(key)}</span>
                <code className="text-xs text-muted-foreground">{`{{${key}}}`}</code>
              </DropdownMenuItem>
            ))}
            {fields.custom.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("fieldsCustom")}</DropdownMenuLabel>
                {fields.custom.map((key) => (
                  <DropdownMenuItem key={key} onSelect={() => insertToken(`{{custom.${key}}}`)}>
                    <span className="flex-1 truncate">{key}</span>
                    <code className="text-xs text-muted-foreground">{`{{custom.${key}}}`}</code>
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Editing surface. */}
      <div
        ref={editorRef}
        contentEditable
        dir="auto"
        role="textbox"
        aria-multiline="true"
        aria-label={t("htmlBody")}
        data-placeholder={t("htmlBodyHint")}
        onInput={emitChange}
        onBlur={() => { saveSelection(); emitChange(); }}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        // Match the sent email's typography (see EMAIL_FONT_STACK) so what the
        // author sees here is what the recipient gets — same font, size and
        // line spacing. line-height 1.6 mirrors wrapEmailBody on the server.
        style={{
          fontFamily: EMAIL_FONT_STACK,
          fontSize: `${fontSize ?? DEFAULT_EMAIL_FONT_SIZE}px`,
          lineHeight: 1.6,
        }}
        className={cn(
          "min-h-[12rem] w-full px-3 py-2 outline-none",
          "[&_a]:text-blue-600 [&_a]:underline",
          "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:ps-6",
          "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        )}
        suppressContentEditableWarning
      />
    </div>
  );
}
