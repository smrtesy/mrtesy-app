import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

/**
 * On-the-fly PWA icon generator.
 *
 * The manifest (`app/manifest.ts`) and the Apple touch-icon link both point
 * here instead of at committed binary PNGs — this keeps the brand mark in
 * one place (the lightbulb that also lives in `src/app/icon.svg`) and lets
 * any size be requested with `?size=`. `?purpose=maskable` insets the mark
 * inside the Android safe zone so the OS mask never clips the bulb.
 *
 * `next/og` ships with Next.js, so this adds no dependency. resvg rasterizes
 * the embedded SVG to a real PNG, which is what iOS/Android installers want.
 */
export const runtime = "nodejs";

// The lightbulb mark on its navy tile — kept in sync with src/app/icon.svg.
const BULB = `
  <path d="M 32 8 C 21 8, 14 16, 14 26 C 14 32, 17 37, 21 41 L 21 46 L 43 46 L 43 41 C 47 37, 50 32, 50 26 C 50 16, 43 8, 32 8 Z" fill="#C9A646"/>
  <rect x="23" y="47" width="18" height="3" rx="0.8" fill="#C9A646"/>
  <rect x="24" y="51" width="16" height="3" rx="0.8" fill="#C9A646"/>
  <path d="M 27 55 L 37 55 L 35 58 L 29 58 Z" fill="#C9A646"/>
  <g fill="none" stroke="#0F1F3D" stroke-width="1.8" stroke-linecap="round">
    <line x1="22" y1="22" x2="32" y2="17"/>
    <line x1="32" y1="17" x2="42" y2="22"/>
    <line x1="22" y1="22" x2="32" y2="30"/>
    <line x1="32" y1="30" x2="42" y2="22"/>
    <line x1="32" y1="30" x2="32" y2="38"/>
  </g>
  <g fill="#0F1F3D">
    <circle cx="22" cy="22" r="2"/>
    <circle cx="32" cy="17" r="2"/>
    <circle cx="42" cy="22" r="2"/>
    <circle cx="32" cy="30" r="2"/>
    <circle cx="32" cy="38" r="2"/>
  </g>
`;

// Solid white silhouette of the same bulb (no circuit) for the Android
// notification status-bar icon (the "badge"). Android keeps only the alpha
// channel and recolors it white, so this must be a single-color shape on a
// fully transparent background — otherwise the whole tile reads as a blank box.
const BULB_SILHOUETTE = `
  <path d="M 32 8 C 21 8, 14 16, 14 26 C 14 32, 17 37, 21 41 L 21 46 L 43 46 L 43 41 C 47 37, 50 32, 50 26 C 50 16, 43 8, 32 8 Z" fill="#FFFFFF"/>
  <rect x="23" y="47" width="18" height="3" rx="0.8" fill="#FFFFFF"/>
  <rect x="24" y="51" width="16" height="3" rx="0.8" fill="#FFFFFF"/>
  <path d="M 27 55 L 37 55 L 35 58 L 29 58 Z" fill="#FFFFFF"/>
`;

function svgDataUri(viewBox: string, mark: string = BULB): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${mark}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // Guard against non-numeric ?size= — parseInt("abc") is NaN, which would
  // pass through Math.min/max and crash ImageResponse with width/height NaN.
  const requested = parseInt(searchParams.get("size") || "512", 10);
  const size = Math.min(1024, Math.max(48, Number.isFinite(requested) ? requested : 512));
  const maskable = searchParams.get("purpose") === "maskable";
  // Monochrome, transparent silhouette for the Android notification badge.
  const mono = searchParams.get("purpose") === "badge" || searchParams.get("mono") === "1";

  // Maskable icons keep the mark inside the central ~80% safe zone; the badge
  // fills most of its frame; standard icons use a modest margin.
  const padFactor = mono ? 0.08 : maskable ? 0.18 : 0.1;
  const pad = size * padFactor;
  const inner = size - pad * 2;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: mono ? "transparent" : "#0F1F3D",
        }}
      >
        {/* The bulb viewBox is 14..50 wide, so widen it slightly for centering.
            next/image can't be used here — this renders inside Satori (next/og),
            not the DOM, so the no-img-element rule doesn't apply. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          width={inner}
          height={inner}
          src={svgDataUri("8 4 48 58", mono ? BULB_SILHOUETTE : BULB)}
          alt="smrtesy"
        />
      </div>
    ),
    {
      width: size,
      height: size,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  );
}
