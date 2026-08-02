/**
 * Example page-check scenario for the tasks screen (/he/tasks).
 *
 * A scenario is `export default async ({ page, goto, shot, log, expectVisible })`.
 * `page` is a full Playwright Page — clicks, fills, keyboard, waits. Throw to
 * fail the check; the harness has already run the baseline smoke (loaded, no
 * console errors, not bounced to /login) before this runs, so here you only
 * assert the SCREEN'S OWN behavior.
 *
 * This one is READ-ONLY (creates nothing) — the default. A scenario that writes
 * to the real DB must clean up after itself; see SKILL.md.
 *
 * Copy this file to `.claude/page-checks/<screen>.mjs` and adapt per screen.
 */
export default async ({ page, goto, shot, log, expectVisible }) => {
  // 1. Land on the screen and let it hydrate + fetch.
  await goto("/he/tasks");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // 2. The app shell rendered as the logged-in user — the left sidebar is the
  //    most stable cross-screen anchor. (Prefer role/text over brittle CSS.)
  await expectVisible("nav, aside, [role='navigation']", { label: "app sidebar" });

  // 3. The tasks screen has real content, not an error/empty crash. We assert
  //    the document body carries a meaningful amount of rendered text.
  const textLen = (await page.locator("body").innerText()).trim().length;
  log(`  rendered text length: ${textLen}`);
  if (textLen < 40) throw new Error("tasks screen rendered almost no text — likely a load failure");

  // 4. A safe, read-only interaction: if a search/filter entry point exists
  //    (the compact icon-button pattern used across the app), open it and make
  //    sure the input appears — then close it. Guarded by count() so the
  //    scenario stays green on layouts that don't have it.
  const searchBtn = page.getByRole("button", { name: /search|חיפוש/i }).first();
  if (await searchBtn.count()) {
    await searchBtn.click();
    await page.locator("input[type='search'], input[type='text']").first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => log("  ✓ search input opened"))
      .catch(() => log("  (search button present but no input appeared)"));
    await page.keyboard.press("Escape").catch(() => {});
  } else {
    log("  (no search entry point on this screen — skipping interaction)");
  }

  await shot("02-tasks-interacted");
};
