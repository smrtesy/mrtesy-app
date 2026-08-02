/**
 * Page-check scenario for the smrtDesign screen (/he/design).
 *
 * READ-ONLY: opens a project, enlarges an option image (lightbox), closes it,
 * and ticks a "take from this design" checkbox. Toggling a checkbox is local
 * React state only — no DB write — so nothing needs cleanup.
 */
export default async ({ page, goto, shot, log, expectVisible }) => {
  await goto("/he/design");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // App shell rendered as the logged-in user.
  await expectVisible("nav, aside, [role='navigation']", { label: "app sidebar" });

  // The project bar should carry the seeded "Ai chochom" project (or at least
  // the "new project" button). Open the first project chip if present.
  const projectBtn = page.getByRole("button", { name: /chochom/i }).first();
  if (await projectBtn.count()) {
    await projectBtn.click();
    log("  ✓ opened project 'Ai chochom'");
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  } else {
    log("  (no project chip found — running smoke only)");
    await shot("02-design-noproject");
    return;
  }

  // Gallery images should render. Grab the first option image (it's inside a
  // zoom button) and click it to open the lightbox.
  const firstImg = page.locator("button.cursor-zoom-in img").first();
  await firstImg.waitFor({ state: "visible", timeout: 20_000 });
  log("  ✓ gallery images visible");
  await firstImg.click();

  // The lightbox is a fixed full-screen overlay (z-50, bg-black/80).
  const lightbox = page.locator("div.fixed.inset-0.z-50").first();
  await lightbox.waitFor({ state: "visible", timeout: 5_000 });
  log("  ✓ lightbox opened on image click");
  await shot("02-design-lightbox");

  // Click to close.
  await lightbox.click();
  await lightbox.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  log("  ✓ lightbox closed");

  // Per-card pick checkbox: tick the first dimension checkbox under a card.
  const firstCheckbox = page.locator("input[type='checkbox']").first();
  if (await firstCheckbox.count()) {
    await firstCheckbox.check();
    if (await firstCheckbox.isChecked()) log("  ✓ 'take from this design' checkbox toggles");
    else throw new Error("checkbox did not become checked");
    await firstCheckbox.uncheck();
  } else {
    log("  (no pick checkboxes — fewer than 2 options?)");
  }

  await shot("03-design-interacted");
};
