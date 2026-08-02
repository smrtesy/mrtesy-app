/**
 * Page-check scenario for the smrtStudio operator console (/he/studio).
 *
 * READ-ONLY: it opens the console, drills into a stage, and — if the Edit
 * button is present for the logged-in user — enters edit mode and asserts the
 * edit controls render. It NEVER types into a field or clicks add/delete, so
 * no studio_* row is ever written (edits commit on blur, which we never trigger).
 */
export default async ({ page, goto, log, shot, expectVisible }) => {
  // 1. Land + hydrate.
  await goto("/he/studio");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // 2. The app shell is present (logged-in), and the console itself mounted
  //    (its whole surface lives under `.ss-app`).
  await expectVisible("nav, aside, [role='navigation']", { label: "app sidebar" });
  await expectVisible(".ss-app", { label: "studio console root" });

  const textLen = (await page.locator("body").innerText()).trim().length;
  log(`  rendered text length: ${textLen}`);
  if (textLen < 40) throw new Error("studio console rendered almost no text — likely a load failure");

  // 3. Open the first stage's focus view (read view), then return.
  const firstStage = page.locator(".ss-tab").first();
  if (await firstStage.count()) {
    await firstStage.click();
    await page.locator(".ss-section, .ss-plan").first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => log("  ✓ stage focus view opened"))
      .catch(() => log("  (stage clicked but no focus section appeared)"));
    await shot("02-studio-stage");
  }

  // 4. Edit mode — only rendered for admins. Guarded so the check stays green
  //    for a non-admin session (it just logs and skips).
  const editBtn = page.getByRole("button", { name: /^(edit|done)$/i }).first();
  if (await editBtn.count()) {
    await editBtn.click();
    // The edit banner and at least one editable input should appear.
    await expectVisible(".ss-editbanner", { label: "edit-mode banner" });
    // Re-open a stage in edit mode to render the StageEditor form.
    const st = page.locator(".ss-tab").first();
    if (await st.count()) {
      await st.click();
      await page.locator(".ss-inp, .ss-ta, .ss-sel").first()
        .waitFor({ state: "visible", timeout: 8_000 });
      const inputs = await page.locator(".ss-inp, .ss-ta, .ss-sel").count();
      const addBtns = await page.locator(".ss-add").count();
      log(`  ✓ edit mode: ${inputs} editable fields, ${addBtns} add buttons rendered`);
      if (inputs < 1) throw new Error("edit mode entered but no editable fields rendered");
    }
    await shot("03-studio-edit");
    // Leave edit mode (no changes were made).
    await page.getByRole("button", { name: /^done$/i }).first().click().catch(() => {});
  } else {
    log("  (no Edit button for this session — not an admin; read-only view verified)");
  }
};
