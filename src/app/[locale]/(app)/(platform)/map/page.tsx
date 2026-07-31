import { SiteMap } from "@/components/platform/map/SiteMap";

/**
 * /map — the site map. Everything the screen needs comes from the client
 * (i18n + AppAccessContext, published by (app)/layout.tsx), so the routed page
 * and the registered pane render exactly the same component.
 */
export default function SiteMapPage() {
  return <SiteMap />;
}
