"use client";

/**
 * ZoomableImage — a thumbnail that opens its full image in an in-app popup
 * (a lightbox overlay), NOT a new browser window.
 *
 * The Claude console shows run screenshots and Claude-authored markdown images
 * as thumbnails; a click used to open the raw (signed) URL in a new browser
 * tab, leaving the workspace behind. This opens the full image over the app
 * instead — click the backdrop, press Escape, or hit the ✕ to close.
 *
 * The overlay is portaled to `document.body` so it escapes any scroll
 * container / stacking context it was rendered inside and covers the surface
 * it sits on (the whole window as a component pane; the pane's own frame as a
 * legacy iframe pane) — either way an in-app popup, never a new window.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

export function ZoomableImage({
  src,
  alt,
  title,
  className,
  imgClassName,
  loading = "lazy",
}: {
  src: string;
  alt: string;
  /** Thumbnail tooltip; falls back to `alt`. */
  title?: string;
  /** Class on the thumbnail wrapper button. */
  className?: string;
  /** Class on the thumbnail <img>. */
  imgClassName?: string;
  loading?: "lazy" | "eager";
}) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);

  // Escape closes the popup.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openPopup = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    // preventDefault + stopPropagation so a zoomable image that sits INSIDE a
    // markdown link (`[![alt](img)](url)`) opens the popup rather than
    // navigating the anchor — and never does both.
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      {/* A <span role="button">, NOT a <button>: this can render inline inside a
          markdown <p> and even inside an <a> (a linked image) — a nested
          <button> there is invalid HTML and triggers a hydration error. */}
      <span
        role="button"
        tabIndex={0}
        onClick={openPopup}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") openPopup(e);
        }}
        title={title ?? alt}
        aria-label={t("zoomImage")}
        className={cn("block cursor-zoom-in", className)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed/ephemeral
            or doc-authored URL, not a site asset; next/image would proxy a URL
            that may expire. */}
        <img src={src} alt={alt} loading={loading} className={imgClassName} />
      </span>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 sm:p-8"
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label={title ?? alt}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              className="absolute end-3 top-3 rounded-full bg-black/50 p-2 text-white/90 transition-colors hover:bg-black/70 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
            <img
              src={src}
              alt={alt}
              // A click on the image itself must not close the popup — only the
              // backdrop / ✕ / Escape do.
              onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full cursor-default rounded-lg object-contain shadow-2xl"
            />
          </div>,
          document.body,
        )}
    </>
  );
}
