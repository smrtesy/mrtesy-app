"use client";

import { useEffect } from "react";

/**
 * Guarantees the `data-embed` flag is set on <html> when a page is loaded
 * inside a tabs-workspace pane (?embed=1).
 *
 * The layout also sets this via an inline parse-time script (no flash when it
 * runs), but raw inline scripts in the App Router don't always execute; this
 * client effect is the reliable fallback so globals.css can drop the chrome
 * offsets (margins / max-width) inside the pane regardless.
 */
export function EmbedFlag() {
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("embed") === "1") {
        document.documentElement.setAttribute("data-embed", "1");
      }
    } catch {
      /* non-fatal */
    }
  }, []);
  return null;
}
