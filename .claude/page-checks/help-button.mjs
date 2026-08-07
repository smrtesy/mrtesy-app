// Verifies the report-a-problem flag placement after moving it into the sidebar
// Claude row. Read-only: only clicks the sidebar collapse toggle (a pure
// CSS/layout switch), no DB writes.
const flag = "[data-feature-report-floating]";

export default async ({ page, shot, log }) => {
  // 1) Sidebar OPEN: the flag lives inline in the Claude row; the floating flag
  //    must be hidden on desktop.
  await shot("sidebar-open");
  const openVisible = await page.locator(flag).isVisible();
  log(`sidebar open → floating flag visible: ${openVisible} (expect false)`);
  if (openVisible) throw new Error("floating flag should be hidden on desktop while sidebar is open");

  // 2) Collapse the sidebar via the real toggle button.
  await page.locator('button[aria-label="Collapse sidebar"]').click();
  await page.waitForTimeout(400);
  const attr = await page.evaluate(() => document.body.getAttribute("data-sidebar-collapsed"));
  const disp = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : "no-element";
  }, flag);
  log(`after collapse → body[data-sidebar-collapsed]=${attr}, floating computed display=${disp}`);
  await shot("sidebar-collapsed");
  const collapsedVisible = await page.locator(flag).isVisible();
  log(`sidebar collapsed → floating flag visible: ${collapsedVisible} (expect true)`);
  if (!collapsedVisible) throw new Error("floating flag should reappear when sidebar is collapsed");
};
