"use client";

/**
 * The rich markdown editor, code-split.
 *
 * `MarkdownEditor` pulls in ProseMirror + Milkdown (~110 kB), and every place
 * that offers it keeps it behind a collapsed panel or a dialog — so it must
 * not sit in any route's first load. Importing it through this one module
 * means every caller shares a single lazy chunk instead of each creating its
 * own. It also needs a DOM to construct, hence no SSR.
 */

import dynamic from "next/dynamic";

export const LazyMarkdownEditor = dynamic(
  () => import("@/components/common/MarkdownEditor").then((m) => m.MarkdownEditor),
  {
    ssr: false,
    loading: () => <p className="p-1 text-xs text-muted-foreground">…</p>,
  },
);
