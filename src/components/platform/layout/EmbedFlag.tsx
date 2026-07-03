"use client";

import { useEffect } from "react";
import { isEmbeddedPane } from "@/lib/navigate";

/**
 * Guarantees the `data-embed` flag is set on <html> when a page is loaded
 * inside a tabs-workspace pane.
 *
 * The layout also sets this via an inline parse-time script (no flash when it
 * runs), but raw inline scripts in the App Router don't always execute; this
 * client effect is the reliable fallback so globals.css can drop the chrome
 * offsets (margins / max-width) inside the pane regardless.
 *
 * Detection is structural (are we framed?) rather than `?embed=1`-only, so the
 * flag re-asserts itself after an in-pane reload or navigation that dropped the
 * query — otherwise the mobile chrome would flood back into the pane.
 */
export function EmbedFlag() {
  useEffect(() => {
    if (isEmbeddedPane()) {
      document.documentElement.setAttribute("data-embed", "1");
    }
  }, []);
  return null;
}
