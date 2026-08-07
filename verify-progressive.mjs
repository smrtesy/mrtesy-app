export default async ({ page, goto, shot, log }) => {
  const t0 = Date.now();
  await goto("/he/claude?thread=cd1c342d-bb47-4f0d-9a7e-12a793a6fccd");
  // Wait until the conversation content is present (a bubble rendered).
  await page.waitForTimeout(3500);
  log("load wall-time ms: " + (Date.now() - t0));

  // The "show earlier" control exists ONLY when the progressive-render window
  // hides older turns — its presence proves the fix is live and working.
  const earlier = await page.getByText(/הודעות קודמות/).count();
  log("show-earlier control count: " + earlier);

  // Scroll the chat scroller to the very top so the control is in view.
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));
    let best = null, bestH = 0;
    for (const el of els) {
      const s = getComputedStyle(el);
      const gap = el.scrollHeight - el.clientHeight;
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && gap > bestH) {
        bestH = gap; best = el;
      }
    }
    if (best) best.scrollTop = 0;
  });
  await page.waitForTimeout(1200);

  const earlierTop = await page.getByText(/הודעות קודמות/).count();
  log("show-earlier control after scroll-to-top: " + earlierTop);

  await shot("top.png");
};
