/**
 * web-action — live-view over CDP (headless-friendly, no X display).
 *
 * Screencast: `Page.startScreencast` streams JPEG frames from the headless
 * Chromium; we forward each to the caller (an SSE response) and ack it. Input:
 * the user's mouse/keyboard from the viewer are dispatched back with
 * `Input.dispatch*`, so they can solve a CAPTCHA in place while the agent drives
 * the rest. Transport is SSE (server→client) + plain POST (client→server) — no
 * WebSocket dependency, standard `requireAuth` on both.
 */

import type { WebSession } from "./browser-session";
import { getCdp } from "./browser-session";

/**
 * Start streaming frames. `onFrame` gets a base64 JPEG per frame. Returns a stop
 * function that halts the screencast — call it when the SSE client disconnects.
 */
export async function startScreencast(
  s: WebSession,
  onFrame: (b64Jpeg: string) => void,
): Promise<() => Promise<void>> {
  const cdp = await getCdp(s);

  const handler = (evt: { data: string; sessionId: number }) => {
    onFrame(evt.data);
    // Ack so Chromium keeps sending frames; ignore errors (session may be gone).
    void cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", handler);

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });

  return async () => {
    cdp.off("Page.screencastFrame", handler);
    await cdp.send("Page.stopScreencast").catch(() => {});
  };
}

export type InputEvent =
  | { kind: "mouse"; type: "move" | "down" | "up"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "scroll"; x: number; y: number; deltaX?: number; deltaY?: number }
  | { kind: "key"; type: "down" | "up"; key: string; code?: string; text?: string }
  | { kind: "text"; text: string };

/** Dispatch one relayed user input into the live page via CDP. */
export async function dispatchInput(s: WebSession, e: InputEvent): Promise<void> {
  const cdp = await getCdp(s);
  switch (e.kind) {
    case "mouse":
      await cdp.send("Input.dispatchMouseEvent", {
        type: e.type === "move" ? "mouseMoved" : e.type === "down" ? "mousePressed" : "mouseReleased",
        x: e.x,
        y: e.y,
        button: e.button ?? "left",
        clickCount: e.type === "move" ? 0 : 1,
      });
      break;
    case "scroll":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: e.x,
        y: e.y,
        deltaX: e.deltaX ?? 0,
        deltaY: e.deltaY ?? 0,
      });
      break;
    case "key":
      await cdp.send("Input.dispatchKeyEvent", {
        type: e.type === "down" ? "keyDown" : "keyUp",
        key: e.key,
        code: e.code,
        text: e.text,
      });
      break;
    case "text":
      // Fast path for typing a string (autofill, pasted codes).
      await cdp.send("Input.insertText", { text: e.text });
      break;
    default:
      throw new Error("unknown input kind");
  }
}
