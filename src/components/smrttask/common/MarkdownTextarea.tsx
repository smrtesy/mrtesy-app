"use client";

import { useRef, type KeyboardEvent, type ComponentProps } from "react";
import { Textarea } from "@/components/ui/textarea";

/**
 * Textarea with light-markdown keyboard shortcuts (spec §10 — no full WYSIWYG):
 *   Ctrl/Cmd+B → wraps the selection with **bold**
 *   Ctrl/Cmd+I → wraps the selection with *italic*
 *   Ctrl/Cmd+K → wraps the selection as [text](url), selecting the "url"
 *                placeholder so the user can paste a link straight in.
 *                If the selection is itself a URL, it becomes the href and
 *                the label placeholder is selected instead.
 *
 * Output is rendered with MarkdownLite. Controlled component: pass `value`
 * + `onValueChange`.
 */

interface Props extends Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> {
  value: string;
  onValueChange: (next: string) => void;
}

export function MarkdownTextarea({ value, onValueChange, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Restore focus + selection after React re-renders with the new value.
  function selectAfterRender(start: number, end: number) {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "b" && key !== "i" && key !== "k") return;
    e.preventDefault();

    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);

    if (key === "b" || key === "i") {
      const mark = key === "b" ? "**" : "*";
      onValueChange(value.slice(0, start) + mark + selected + mark + value.slice(end));
      // Keep the original text selected (or the caret between empty marks).
      selectAfterRender(start + mark.length, end + mark.length);
      return;
    }

    // Ctrl/Cmd+K — markdown link.
    if (/^https?:\/\/\S+$/.test(selected)) {
      // Selection is a URL → use it as the href, select the label placeholder.
      const insert = `[](${selected})`;
      onValueChange(value.slice(0, start) + insert + value.slice(end));
      selectAfterRender(start + 1, start + 1);
    } else {
      const placeholder = "url";
      const insert = `[${selected}](${placeholder})`;
      onValueChange(value.slice(0, start) + insert + value.slice(end));
      const urlStart = start + 1 + selected.length + 2; // "[" + label + "]("
      selectAfterRender(urlStart, urlStart + placeholder.length);
    }
  }

  return (
    <Textarea
      ref={ref}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
