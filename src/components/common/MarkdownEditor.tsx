"use client";

/**
 * MarkdownEditor — edit the document as the *rendered* document.
 *
 * The plain textarea is still there (the "code" view in the caller), but it
 * is no longer the only way in: here headings look like headings, tables look
 * like tables, and typing happens inside them. Markdown stays the source of
 * truth end to end — Milkdown parses with remark and serializes back with
 * remark, so what leaves this component is still a markdown string, not HTML
 * pretending to be one.
 *
 * Styling deliberately mirrors `Markdown.tsx` rule for rule, so toggling
 * between "edit pretty" and "preview" is not a visual jump. Direction is
 * handled the same way too: the shell takes the document's majority script
 * and `[unicode-bidi:plaintext]` lets each block resolve its own direction as
 * the user types, which is the closest a live editor gets to the renderer's
 * per-block `dir`.
 */

import { useEffect, useRef, useState } from "react";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";

import { majorityDir } from "@/components/common/Markdown";
import { cn } from "@/lib/utils";

/**
 * The editor's own stylesheet, expressed as Tailwind arbitrary variants on
 * the ProseMirror root. Kept in one string so it sits next to the renderer's
 * classes and drifts with them, rather than hiding in a global CSS file.
 */
const PROSE = [
  // ProseMirror root — the editable surface itself.
  "[&_.ProseMirror]:min-h-[16rem] [&_.ProseMirror]:outline-none",
  "[&_.ProseMirror]:text-sm [&_.ProseMirror]:text-foreground",

  // Blocks resolve their own direction as you type — a Hebrew paragraph and
  // an English one can live in the same document, same as in the renderer.
  "[&_.ProseMirror>*]:[unicode-bidi:plaintext]",

  // Headings — same scale and rules as Markdown.tsx.
  "[&_.ProseMirror_h1]:mb-3 [&_.ProseMirror_h1]:mt-6 [&_.ProseMirror_h1]:border-b [&_.ProseMirror_h1]:pb-1.5 [&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-bold",
  "[&_.ProseMirror_h2]:mb-2.5 [&_.ProseMirror_h2]:mt-6 [&_.ProseMirror_h2]:border-b [&_.ProseMirror_h2]:pb-1.5 [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-bold",
  "[&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-5 [&_.ProseMirror_h3]:text-base [&_.ProseMirror_h3]:font-semibold",
  "[&_.ProseMirror_h4]:mb-1.5 [&_.ProseMirror_h4]:mt-4 [&_.ProseMirror_h4]:text-sm [&_.ProseMirror_h4]:font-semibold",
  "[&_.ProseMirror_h5]:mb-1.5 [&_.ProseMirror_h5]:mt-4 [&_.ProseMirror_h5]:text-sm [&_.ProseMirror_h5]:font-semibold",
  "[&_.ProseMirror_h6]:mb-1.5 [&_.ProseMirror_h6]:mt-4 [&_.ProseMirror_h6]:text-xs [&_.ProseMirror_h6]:font-semibold [&_.ProseMirror_h6]:uppercase [&_.ProseMirror_h6]:tracking-wide [&_.ProseMirror_h6]:text-muted-foreground",
  "[&_.ProseMirror>:first-child]:mt-0",

  "[&_.ProseMirror_p]:my-2.5 [&_.ProseMirror_p]:leading-relaxed",

  "[&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:decoration-primary/40 [&_.ProseMirror_a]:underline-offset-2",

  "[&_.ProseMirror_ul]:my-2.5 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:ps-6 [&_.ProseMirror_ul]:leading-relaxed",
  "[&_.ProseMirror_ol]:my-2.5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:ps-6 [&_.ProseMirror_ol]:leading-relaxed",
  "[&_.ProseMirror_li]:my-1 [&_.ProseMirror_li_p]:my-0",
  "[&_.ProseMirror_li]:marker:text-muted-foreground",
  // Task items carry their own checkbox — drop the bullet, same as the renderer.
  "[&_.ProseMirror_li[data-item-type=task]]:list-none",

  "[&_.ProseMirror_blockquote]:my-3 [&_.ProseMirror_blockquote]:border-s-4 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:bg-muted/30 [&_.ProseMirror_blockquote]:py-1 [&_.ProseMirror_blockquote]:ps-3 [&_.ProseMirror_blockquote]:text-muted-foreground",

  "[&_.ProseMirror_hr]:my-5 [&_.ProseMirror_hr]:border-t [&_.ProseMirror_hr]:border-border",

  // Code is always LTR — source stays source even inside a Hebrew document.
  "[&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:border [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1.5 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:font-mono [&_.ProseMirror_code]:text-[0.85em]",
  // The renderer gets this from `dir="ltr"` on the <code>; here it has to be
  // CSS. Without the isolate, a path like `~/.claude/…` inside a Hebrew
  // sentence has its leading `~/` reordered to the end by the bidi algorithm.
  "[&_.ProseMirror_code]:[direction:ltr] [&_.ProseMirror_code]:[unicode-bidi:isolate]",
  "[&_.ProseMirror_pre]:my-3 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:bg-muted/50 [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:font-mono [&_.ProseMirror_pre]:text-[12.5px] [&_.ProseMirror_pre]:leading-relaxed",
  "[&_.ProseMirror_pre]:![direction:ltr] [&_.ProseMirror_pre]:text-start",
  "[&_.ProseMirror_pre_code]:border-0 [&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_pre_code]:p-0 [&_.ProseMirror_pre_code]:text-inherit",

  // Tables — same borders/zebra as the renderer, plus a visible cell focus
  // ring so it is obvious which cell is being typed into.
  "[&_.ProseMirror_table]:my-3 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_table]:text-[13px]",
  "[&_.ProseMirror_th]:border [&_.ProseMirror_th]:bg-muted/60 [&_.ProseMirror_th]:px-3 [&_.ProseMirror_th]:py-1.5 [&_.ProseMirror_th]:text-start [&_.ProseMirror_th]:align-top [&_.ProseMirror_th]:font-semibold",
  "[&_.ProseMirror_td]:border [&_.ProseMirror_td]:px-3 [&_.ProseMirror_td]:py-1.5 [&_.ProseMirror_td]:text-start [&_.ProseMirror_td]:align-top",
  "[&_.ProseMirror_th_p]:my-0 [&_.ProseMirror_td_p]:my-0",
  "[&_.ProseMirror_.selectedCell]:relative [&_.ProseMirror_.selectedCell]:bg-primary/10",

  "[&_.ProseMirror_img]:my-3 [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:rounded-lg [&_.ProseMirror_img]:border",
  "[&_.ProseMirror_del]:text-muted-foreground",
].join(" ");

/** A markdown table row — leading pipe, at least one more pipe. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Repair the one thing the serializer gets *wrong* rather than merely
 * reformats.
 *
 * A GFM table may have empty cells — the identity table in the standing
 * instructions has a fully empty header row. Round-tripping one produces a
 * literal `<br />` in that cell, and since the renderer does not execute raw
 * HTML the user would then see the characters "<br />" printed in their
 * table. Everything else the serializer changes (cell padding, `_` escapes,
 * bare emails becoming autolinks) renders identically, so it is left alone.
 */
function repairSerialized(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      TABLE_ROW.test(line)
        ? line
            .split("|")
            .map((cell) => (cell.trim() === "<br />" ? " ".repeat(cell.length) : cell))
            .join("|")
        : line,
    )
    .join("\n");
}

export interface MarkdownEditorProps {
  /** Markdown source. Only the FIRST value is loaded into the editor. */
  value: string;
  /** Fires with the serialized markdown on every edit. */
  onChange: (markdown: string) => void;
  className?: string;
  /** Rendered when the document is empty. */
  placeholder?: string;
}

function EditorSurface({ value, onChange }: Omit<MarkdownEditorProps, "className" | "placeholder">) {
  /**
   * The editor owns the document once it is mounted. Routing `onChange`
   * through a ref keeps the callback fresh without the identity of a new
   * closure re-running `useEditor` — which would rebuild the editor and throw
   * away the user's cursor (and undo history) on every keystroke.
   */
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // `value` is read once, on mount, on purpose: this is an uncontrolled
  // editor. Feeding every parent re-render back in would fight the user's
  // cursor. The caller unmounts it when it wants a genuine reload.
  const initial = useRef(value);

  /**
   * Has the user actually touched the document?
   *
   * Parsing markdown and serializing it back is not lossless in FORMATTING
   * (table cells get padded, `_` gets escaped), and Milkdown reports that
   * normalization on load — which would light up "unsaved changes" on a
   * document nobody edited, and quietly persist a reformat on the next save.
   * Gating on a real input event is precise: `markdownUpdated` only fires
   * when the document actually changed, so the first event after genuine
   * user interaction is a genuine edit. No reliance on emission ordering.
   */
  const touched = useRef(false);

  useEditor((root) => {
    const markTouched = () => {
      touched.current = true;
    };
    // Capture phase + `once`: fires before ProseMirror handles it, and
    // unregisters itself, so there is nothing to clean up on unmount.
    for (const ev of ["beforeinput", "paste", "drop", "cut"] as const) {
      root.addEventListener(ev, markTouched, { capture: true, once: true });
    }

    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial.current);
        // Serialize in the dialect the repo's documents are already written
        // in. Every edit rewrites the WHOLE file, so without this a one-word
        // change lands as a diff that also flips every `-` bullet to `*` and
        // every `---` rule to `***`.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          bullet: "-" as const,
          rule: "-" as const,
          emphasis: "*" as const,
          strong: "*" as const,
          fence: "`" as const,
          fences: true,
          listItemIndent: "one" as const,
          resourceLink: false,
        }));
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { role: "textbox", "aria-multiline": "true" },
        }));
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
          if (!touched.current) return;
          onChangeRef.current(repairSerialized(markdown));
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(cursor)
      .use(trailing);
  });

  return <Milkdown />;
}

export function MarkdownEditor({ value, onChange, className, placeholder }: MarkdownEditorProps) {
  // Direction is fixed at mount for the same reason the document is: re-deriving
  // it mid-typing would flip the whole surface under the user's cursor.
  const dir = useRef(majorityDir(value) ?? "ltr").current;

  // ProseMirror renders nothing for an empty document, so the placeholder is
  // an overlay rather than CSS on a node that does not exist.
  const [empty, setEmpty] = useState(() => value.trim() === "");
  function handleChange(markdown: string) {
    setEmpty(markdown.trim() === "");
    onChange(markdown);
  }

  return (
    <div dir={dir} className={cn("relative", PROSE, className)}>
      {empty && placeholder && (
        <p className="pointer-events-none absolute inset-x-0 top-0 text-sm text-muted-foreground">
          {placeholder}
        </p>
      )}
      <MilkdownProvider>
        <EditorSurface value={value} onChange={handleChange} />
      </MilkdownProvider>
    </div>
  );
}
