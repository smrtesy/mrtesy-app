/**
 * Tiny Web Audio beep — used by the workclock pause nag and the end-of-day
 * close (the marathon had no sound). No asset to load; synthesised on the fly.
 * Silently no-ops where Web Audio is unavailable or blocked (e.g. before any
 * user gesture). Never throws.
 */
export function beep(times = 1): void {
  try {
    const AC: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return;
    const ctx = new AC();
    let t = ctx.currentTime;
    for (let i = 0; i < Math.max(1, times); i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
      t += 0.28;
    }
    setTimeout(() => { ctx.close().catch(() => {}); }, Math.max(1, times) * 300 + 250);
  } catch {
    /* audio unavailable — nags fall back to the visual pulse */
  }
}
