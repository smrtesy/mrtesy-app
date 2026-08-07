export default async ({ goto, page, log }) => {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  async function measure(id, threshold) {
    const t0 = Date.now();
    await goto("/he/claude?thread=" + id);
    let ttc = null;
    for (let i = 0; i < 200; i++) {
      const len = await page.evaluate(() => document.body.innerText.length);
      if (len > threshold) { ttc = Date.now() - t0; break; }
      await page.waitForTimeout(80);
    }
    const nodes = await page.evaluate(() => document.querySelectorAll("*").length);
    return { ttc, nodes };
  }
  // Heavy first (cold chunk cache), then light (warm) — so the light number is
  // if anything favoured; a big heavy-minus-light delta is then a lower bound on
  // content-render cost, boot excluded.
  const heavy = await measure("cd1c342d-bb47-4f0d-9a7e-12a793a6fccd", 3000);
  const light = await measure("0c9acc30-cc36-4331-b340-c454a49d813d", 800);
  log("HEAVY (11 turns): ttc=" + heavy.ttc + "ms  nodes=" + heavy.nodes);
  log("LIGHT (2 turns): ttc=" + light.ttc + "ms  nodes=" + light.nodes);
  log("delta (content-render cost, boot excluded): " + (heavy.ttc - light.ttc) + "ms");
};
