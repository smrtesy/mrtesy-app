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

export default router;
