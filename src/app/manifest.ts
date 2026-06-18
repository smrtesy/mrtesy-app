import type { MetadataRoute } from "next";

/**
 * Web App Manifest — drives the installable PWA experience.
 *
 * Next.js serves this at `/manifest.webmanifest` (referenced from the
 * root layout metadata). `display: "standalone"` is what removes the
 * browser address bar and gives the launched app its native, full-screen
 * chrome. Icons are produced on the fly by `/api/icon` (see that route),
 * so we never have to commit binary PNGs to the repo.
 *
 * Colors: both `background_color` (the splash shown while the app boots) and
 * `theme_color` (the installed app's status bar) use the branded navy. The
 * manifest only allows one static `theme_color`, so navy is the safe choice —
 * it stays readable with light status icons in both light and dark mode,
 * whereas a cream bar would hide the status icons for dark-mode users. The
 * browser tab still gets a light/dark-aware bar via the `viewport.themeColor`
 * media queries in the root layout.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "smrtesy — Smart & Easy",
    short_name: "smrtesy",
    description: "Personal AI Brain",
    // "/" lets the middleware route the user to their saved language and
    // the right authenticated landing page on launch.
    start_url: "/",
    scope: "/",
    display: "standalone",
    // iOS ignores `display` but honors this older key; keep both so the
    // app opens chrome-less on every platform.
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait",
    background_color: "#0F1F3D",
    theme_color: "#0F1F3D",
    lang: "he",
    dir: "rtl",
    categories: ["productivity", "business", "utilities"],
    icons: [
      // Static PNG files (not the dynamic /api/icon route): Android's WebAPK
      // minting server and iOS fetch these at install time and can choke on a
      // cold-starting dynamic route, which shows up as a blank white icon.
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
