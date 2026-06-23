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
