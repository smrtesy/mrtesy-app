/**
 * web-action REST — the agent's control surface over a backend browser session.
 *
 * Every route is authenticated + org-scoped (`requireAuth + requireOrg`), and
 * each session is additionally owner-scoped inside browser-session.ts, so one
 * user can never touch another's live browser. This is slice 1 (session +
 * driving); the live-view WebSocket (CDP screencast + input relay) and the
 * autonomy engine / vault write are added on top.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg } from "../../middleware";
import * as bs from "./browser-session";
import { latestSmsCode, latestEmailCode } from "./code-extract";
import { storeSecret } from "./vault-store";
import { startScreencast, dispatchInput, type InputEvent } from "./live-view";

const router = Router();

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Powerful capability — same auth as the rest of the app, never public.
router.use("/web-action", requireAuth, requireOrg);

/** POST /web-action/sessions — launch a fresh browser session. */
router.post("/web-action/sessions", async (req: Request, res: Response) => {
  try {
    const session = await bs.createSession(req.user!.id, req.org!.id);
    res.status(201).json({ session });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

/** GET /web-action/sessions — the caller's own live sessions. */
router.get("/web-action/sessions", async (req: Request, res: Response) => {
  res.json({ sessions: await bs.listSessions(req.user!.id) });
});

/** POST /web-action/sessions/:id/navigate  Body: { url } */
router.post("/web-action/sessions/:id/navigate", async (req: Request, res: Response) => {
  const s = bs.getOwnedSession(req.params.id, req.user!.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json({ session: await bs.navigate(s, String((req.body ?? {}).url ?? "")) });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

/** POST /web-action/sessions/:id/act  Body: { type, selector?, text?, key? } */
router.post("/web-action/sessions/:id/act", async (req: Request, res: Response) => {
  const s = bs.getOwnedSession(req.params.id, req.user!.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json({ session: await bs.act(s, (req.body ?? {}) as bs.Action) });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

/** GET /web-action/sessions/:id/screenshot[?full=1] — base64 PNG of the page. */
router.get("/web-action/sessions/:id/screenshot", async (req: Request, res: Response) => {
  const s = bs.getOwnedSession(req.params.id, req.user!.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    res.json({ image: await bs.screenshotDataUrl(s, req.query.full === "1") });
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

/** DELETE /web-action/sessions/:id — close and free the browser. */
router.delete("/web-action/sessions/:id", async (req: Request, res: Response) => {
  const ok = await bs.closeSession(req.params.id, req.user!.id);
  res.json({ ok });
});

// ── live-view: SSE screencast (server→client) + input relay (client→server) ──

/** GET /web-action/sessions/:id/stream — SSE stream of base64 JPEG frames. */
router.get("/web-action/sessions/:id/stream", async (req: Request, res: Response) => {
  const s = bs.getOwnedSession(req.params.id, req.user!.id);
  if (!s) return res.status(404).json({ error: "session not found" });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
  });
  res.flushHeaders?.();

  let stop: (() => Promise<void>) | null = null;
  try {
    stop = await startScreencast(s, (b64) => res.write(`data: ${b64}\n\n`));
  } catch (e) {
    res.write(`event: error\ndata: ${msg(e)}\n\n`);
    return res.end();
  }
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    void stop?.();
  });
});

/** POST /web-action/sessions/:id/input — relay one user mouse/key/scroll event. */
router.post("/web-action/sessions/:id/input", async (req: Request, res: Response) => {
  const s = bs.getOwnedSession(req.params.id, req.user!.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  try {
    await dispatchInput(s, (req.body ?? {}) as InputEvent);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

// ── verification-code extraction (email + SMS both land in the platform) ──────

/** GET /web-action/verification/sms[?from=&to=&sinceMs=] — latest inbound SMS code. */
router.get("/web-action/verification/sms", async (req: Request, res: Response) => {
  try {
    const result = await latestSmsCode(req.user!.id, {
      fromPhone: typeof req.query.from === "string" ? req.query.from : undefined,
      toPhone: typeof req.query.to === "string" ? req.query.to : undefined,
      sinceMs: req.query.sinceMs ? Number(req.query.sinceMs) : undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

/** GET /web-action/verification/email[?from=&subject=&sinceMinutes=] — latest email code + link. */
router.get("/web-action/verification/email", async (req: Request, res: Response) => {
  try {
    const result = await latestEmailCode(req.user!.id, {
      fromContains: typeof req.query.from === "string" ? req.query.from : undefined,
      subjectContains: typeof req.query.subject === "string" ? req.query.subject : undefined,
      sinceMinutes: req.query.sinceMinutes ? Number(req.query.sinceMinutes) : undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: msg(e) });
  }
});

// ── store an extracted key/secret into smrtVault ─────────────────────────────

/** POST /web-action/vault/api-key  Body: { label, secret, url?, username?, notes? } */
router.post("/web-action/vault/api-key", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const credential = await storeSecret({
      userId: req.user!.id,
      orgId: req.org!.id,
      label: String(body.label ?? ""),
      secret: String(body.secret ?? ""),
      url: typeof body.url === "string" ? body.url : null,
      username: typeof body.username === "string" ? body.username : null,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    res.status(201).json({ credential });
  } catch (e) {
    res.status(400).json({ error: msg(e) });
  }
});

export default router;
