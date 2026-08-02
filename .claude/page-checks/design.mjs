/**
 * Page-check scenario for smrtDesign (/he/design).
 *
 * READ-ONLY: selects a project, opens the image lightbox, ticks a pick checkbox.
 * None of these write to the DB (lightbox + checkbox are local state; selecting a
 * project is a GET). Baseline smoke (load, no console errors, not bounced to
 * /login) already ran before this.
 */
export default async ({ page, goto, shot, log, expectVisible }) => {
  await goto("/he/design");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  await expectVisible("nav, aside, [role='navigation']", { label: "app sidebar" });

  // A project chip ("Ai chochom" exists in this org). Click the first one.
  const projectChip = page.getByRole("button", { name: /chochom|כיוון|עיצוב|design/i }).first();
  const chips = page.locator("button.rounded-md.border");
  if (await chips.count()) {
    await chips.first().click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    log("  ✓ selected a project");
  } else {
    log("  (no project chips — empty org; smoke only)");
    await shot("02-design-empty");
    return;
  }
  void projectChip;

  // Gallery images render. Click the first to open the lightbox overlay.
  const galleryImg = page.locator("button.cursor-zoom-in img").first();
  if (await galleryImg.count()) {
    log("  ✓ gallery has rendered options");
    await page.locator("button.cursor-zoom-in").first().click();
    // The lightbox is a fixed full-screen overlay (z-50, bg-black/80).
    const lightbox = page.locator("div.fixed.inset-0.z-50");
    await lightbox.waitFor({ state: "visible", timeout: 5_000 })
      .then(() => log("  ✓ lightbox opened"))
      .catch(() => { throw new Error("clicking an option image did not open the lightbox"); });
    await shot("03-design-lightbox");
    // Click to close.
    await lightbox.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await lightbox.waitFor({ state: "hidden", timeout: 5_000 })
      .then(() => log("  ✓ lightbox closed"))
      .catch(() => log("  (lightbox did not close on click — check overlay handler)"));

    // Tick a "take from this design" dimension checkbox (local state only).
    const pickBox = page.locator("input[type='checkbox']").filter({ hasNot: page.locator("[disabled]") });
    // The language checkboxes live in the new-project form (collapsed); the pick
    // checkboxes live under gallery cards. Grab one that sits inside a card.
    const cardCheckbox = page.locator(".cursor-zoom-in").locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]")
      .locator("input[type='checkbox']").first();
    if (await cardCheckbox.count()) {
      await cardCheckbox.check().catch(() => {});
      log("  ✓ ticked a pick-from-this checkbox");
    }
    void pickBox;
  } else {
    log("  (project has no rendered options yet — smoke only)");
  }

  await shot("04-design-interacted");
};
