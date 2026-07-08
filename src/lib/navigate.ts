/**
 * Navigate the top-level browser window, breaking out of the tabs-workspace
 * iframe when the current page is rendered inside a pane (`?embed=1`, see
 * `TabsWorkspace`).
 *
 * Pages that send `X-Frame-Options: DENY` — notably Google's OAuth / sign-in
 * flow — refuse to load inside an iframe and return a bare `403` ("you do not
 * have access to this page"). Initiating such a navigation with
 * `window.location.href` from inside a pane navigates the iframe itself and
 * triggers that 403. Targeting `window.top` loads the flow in the full browser
 * tab instead. Panes are same-origin, so reading `window.top.location` is
 * permitted; we still guard with try/catch and fall back to a normal
 * same-window navigation when not embedded (or if access is ever denied).
 */
export function navigateTop(url: string): void {
  if (typeof window === "undefined") return;
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch {
    // Cross-origin top access denied — fall back to navigating this window.
  }
  window.location.href = url;
}

/** True when the current document is rendered inside a tabs-workspace pane.
 *
 *  The pane iframe is opened with `?embed=1`, but that query is fragile: any
 *  hard reload or plain in-pane navigation (a `<Link>`, `router.push`, or a
 *  `window.location` change that doesn't re-append it) drops the flag, and the
 *  page then re-mounts as full-chrome — mobile sidebar, bottom nav and FABs all
 *  leak back into the narrow pane. So we treat "am I framed in a window that
 *  isn't the top?" as the authoritative signal: it's structural, can't be lost
 *  by navigation, and the tabs workspace is the only thing that iframes our own
 *  pages. The `?embed=1` check stays as a belt-and-suspenders fallback for the
 *  first paint before the frame relationship is readable. */
export function isEmbeddedPane(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.self !== window.top) return true;
  } catch {
    // Accessing window.top threw — we're framed by a cross-origin parent,
    // which still means we're embedded.
    return true;
  }
  return new URLSearchParams(window.location.search).get("embed") === "1";
}

/**
 * Ask the top-level tabs workspace to open `href` as a NEW pane. A link inside
 * a pane lives in an iframe and has no access to the workspace's React context,
 * so a plain navigation would just replace that pane's own iframe. Posting this
 * message to the top window lets its TabsWorkspaceProvider (the single owner of
 * the tab set) call openTab instead. Same-origin panes only; we target the
 * top's exact origin. Returns false if the post couldn't be sent.
 */
export function requestOpenTab(href: string, label: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const target = window.top ?? window;
    target.postMessage({ type: "smrtesy:open-tab", href, label }, window.location.origin);
    return true;
  } catch {
    return false;
  }
}
