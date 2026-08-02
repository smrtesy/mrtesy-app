"use client";

/**
 * WebActionViewer — the phase-2 live-view for the web-action agent.
 *
 * Streams the backend browser session's screen (SSE of base64 JPEG frames from
 * CDP) and, when the user presses "take control", relays their mouse/keyboard
 * back so they can solve a CAPTCHA in place while the agent drives the rest.
 * Control calls go through api(); the frame stream is a manual fetch (EventSource
 * can't send the Authorization header the backend requires).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api, getActiveOrgId } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
// The backend renders the session at this viewport (browser-session.ts).
const FRAME_W = 1280;
const FRAME_H = 800;

interface SessionInfo {
  id: string;
  url: string;
  title: string;
  problems: string[];
}

export function WebActionViewer() {
  const t = useTranslations("webAction");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [url, setUrl] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Open the SSE frame stream for a session (manual fetch so we can send auth).
  const startStream = useCallback(async (sessionId: string) => {
    stopStream();
    const ac = new AbortController();
    abortRef.current = ac;
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const orgId = await getActiveOrgId();
    if (!token || !orgId) {
      setError(t("noAuth"));
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/api/web-action/sessions/${sessionId}/stream`, {
        headers: { Authorization: `Bearer ${token}`, "X-Org-Id": orgId },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Parse complete SSE events (separated by a blank line).
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const evt = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            const payload = line.slice(6);
            if (payload && !payload.startsWith(":")) setFrame(`data:image/jpeg;base64,${payload}`);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  }, [stopStream, t]);

  useEffect(() => () => stopStream(), [stopStream]);

  const createSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const { session: s } = await api<{ session: SessionInfo }>("/api/web-action/sessions", { method: "POST" });
      setSession(s);
      void startStream(s.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const navigate = async () => {
    if (!session || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { session: s } = await api<{ session: SessionInfo }>(
        `/api/web-action/sessions/${session.id}/navigate`,
        { method: "POST", body: { url: url.trim() } },
      );
      setSession(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!session) return;
    stopStream();
    try {
      await api(`/api/web-action/sessions/${session.id}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
    setSession(null);
    setFrame(null);
    setControl(false);
  };

  // ── input relay (only while "take control" is on) ──────────────────────────
  const toFrameCoords = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return {
      x: Math.round((e.clientX - r.left) * (FRAME_W / r.width)),
      y: Math.round((e.clientY - r.top) * (FRAME_H / r.height)),
    };
  };
  const sendInput = (body: Record<string, unknown>) => {
    if (!session) return;
    void api(`/api/web-action/sessions/${session.id}/input`, { method: "POST", body }).catch(() => {});
  };
  const onMouse = (type: "move" | "down" | "up") => (e: React.MouseEvent) => {
    if (!control) return;
    const c = toFrameCoords(e);
    if (c) sendInput({ kind: "mouse", type, ...c });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!control) return;
    const c = toFrameCoords(e);
    if (c) sendInput({ kind: "scroll", ...c, deltaX: e.deltaX, deltaY: e.deltaY });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!control) return;
    e.preventDefault();
    if (e.key.length === 1) sendInput({ kind: "text", text: e.key });
    else sendInput({ kind: "key", type: "down", key: e.key, code: e.code });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>

      <div className="flex flex-wrap items-center gap-2">
        {!session ? (
          <button
            onClick={createSession}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t("start")}
          </button>
        ) : (
          <>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && navigate()}
              placeholder="https://…"
              dir="ltr"
              className="min-w-[16rem] flex-1 rounded-md border px-2 py-1.5 text-sm"
            />
            <button onClick={navigate} disabled={busy} className="rounded-md border px-3 py-1.5 text-sm">
              {t("go")}
            </button>
            <button
              onClick={() => setControl((c) => !c)}
              className={`rounded-md px-3 py-1.5 text-sm ${control ? "bg-amber-500 text-white" : "border"}`}
            >
              {control ? t("releaseControl") : t("takeControl")}
            </button>
            <button onClick={closeSession} className="rounded-md border px-3 py-1.5 text-sm">
              {t("close")}
            </button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600" dir="ltr">{error}</p>}

      <div
        className={`relative overflow-hidden rounded-lg border bg-muted ${control ? "ring-2 ring-amber-500" : ""}`}
        style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}
        tabIndex={0}
        onKeyDown={onKey}
      >
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frame}
            alt="live browser"
            className="h-full w-full select-none"
            draggable={false}
            onMouseMove={onMouse("move")}
            onMouseDown={onMouse("down")}
            onMouseUp={onMouse("up")}
            onWheel={onWheel}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {session ? t("waiting") : t("noSession")}
          </div>
        )}
      </div>

      {session && (
        <p className="text-xs text-muted-foreground" dir="ltr">
          {session.title} — {session.url}
        </p>
      )}
    </div>
  );
}
