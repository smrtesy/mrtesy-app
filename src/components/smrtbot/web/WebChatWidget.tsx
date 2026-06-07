"use client";

/**
 * smrtBot — web chat widget (the panel rendered inside the embed iframe).
 *
 * Reuses the exact WhatsApp conversation engine over the BotChannel seam:
 * the visitor submits a short lead form, we open a session, and the bot's
 * replies (text / buttons / image / list — the same primitives WhatsApp gets)
 * stream back over Supabase Realtime broadcast. Tapping a button sends its id
 * just like a WhatsApp interactive reply, so the experience is identical.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, X, MessageSquareText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export interface WebChatLabels {
  formTitle: string;
  formSubtitle: string;
  nameLabel: string;
  namePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  phoneLabel: string;
  phonePlaceholder: string;
  startButton: string;
  starting: string;
  emailInvalid: string;
  privacyNote: string;
  inputPlaceholder: string;
  send: string;
  launcherLabel: string;
  closeLabel: string;
  headerSubtitle: string;
  errorGeneric: string;
  reconnecting: string;
  poweredBy: string;
}

interface WebMessage {
  id: string;
  direction: "in" | "out";
  kind: "text" | "buttons" | "image" | "list";
  body: string;
  payload: {
    buttons?: { id: string; title: string }[];
    rows?: { id: string; title: string; description?: string }[];
    buttonLabel?: string;
    sectionTitle?: string;
    url?: string;
    caption?: string;
  };
  created_at: string;
}

interface Props {
  slug: string;
  botName: string;
  accentColor: string;
  dir: "rtl" | "ltr";
  labels: WebChatLabels;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const sessionKey = (slug: string) => `smrtbot_web_session::${slug}`;

/** Render WhatsApp-style *bold* and bare URLs as React nodes (no raw HTML). */
function renderRich(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    // Split on *bold* and URLs while keeping the delimiters.
    const parts = line.split(/(\*[^*]+\*|https?:\/\/[^\s]+)/g).filter(Boolean);
    parts.forEach((part, pi) => {
      const key = `${li}-${pi}`;
      if (/^\*[^*]+\*$/.test(part)) {
        out.push(<strong key={key}>{part.slice(1, -1)}</strong>);
      } else if (/^https?:\/\//.test(part)) {
        out.push(
          <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="underline break-all">
            {part}
          </a>,
        );
      } else {
        out.push(<span key={key}>{part}</span>);
      }
    });
    if (li < lines.length - 1) out.push(<br key={`br-${li}`} />);
  });
  return out;
}

export default function WebChatWidget({ slug, botName, accentColor, dir, labels }: Props) {
  const [phase, setPhase] = useState<"form" | "chat">("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<WebMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const accent = accentColor || "#2563eb";

  const appendMessages = useCallback((incoming: WebMessage[]) => {
    setMessages((prev) => {
      const next = [...prev];
      for (const m of incoming) {
        if (m.id && seenIds.current.has(m.id)) continue;
        if (m.id) seenIds.current.add(m.id);
        next.push(m);
      }
      return next;
    });
  }, []);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Subscribe to the visitor's Realtime broadcast topic for live bot replies.
  useEffect(() => {
    if (!token) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`smrtbot-web-${token}`, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "bot_message" }, (message: { payload?: WebMessage }) => {
        if (message.payload) appendMessages([message.payload]);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, appendMessages]);

  // Resume an existing session (token kept in localStorage) on mount.
  useEffect(() => {
    let active = true;
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(sessionKey(slug)) : null;
    if (!saved) return;
    (async () => {
      try {
        const resp = await fetch(`/api/bot/web/${slug}/history?session_token=${encodeURIComponent(saved)}`);
        if (!resp.ok) {
          window.localStorage.removeItem(sessionKey(slug));
          return;
        }
        const data = (await resp.json()) as { messages?: WebMessage[] };
        if (!active) return;
        setToken(saved);
        setPhase("chat");
        appendMessages(data.messages ?? []);
      } catch {
        /* offline — stay on form */
      }
    })();
    return () => {
      active = false;
    };
  }, [slug, appendMessages]);

  const startSession = useCallback(async () => {
    setFormError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setFormError(labels.emailInvalid);
      return;
    }
    setStarting(true);
    try {
      const resp = await fetch(`/api/bot/web/${slug}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead: { name: name.trim(), email: email.trim(), phone: phone.trim() } }),
      });
      const data = (await resp.json()) as { session_token?: string; messages?: WebMessage[]; error?: string };
      if (!resp.ok || !data.session_token) {
        setFormError(data.error ?? labels.errorGeneric);
        return;
      }
      window.localStorage.setItem(sessionKey(slug), data.session_token);
      setToken(data.session_token);
      setPhase("chat");
      appendMessages(data.messages ?? []);
    } catch {
      setFormError(labels.errorGeneric);
    } finally {
      setStarting(false);
    }
  }, [slug, name, email, phone, labels, appendMessages]);

  const sendTurn = useCallback(
    async (body: { text?: string; buttonId?: string }, displayText: string) => {
      if (!token) return;
      setError(null);
      // Optimistic echo of the visitor's own message.
      const localId = `local-${Date.now()}`;
      appendMessages([
        { id: localId, direction: "in", kind: "text", body: displayText, payload: {}, created_at: new Date().toISOString() },
      ]);
      try {
        const resp = await fetch(`/api/bot/web/${slug}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_token: token, ...body }),
        });
        if (!resp.ok) setError(labels.errorGeneric);
      } catch {
        setError(labels.errorGeneric);
      }
    },
    [slug, token, labels, appendMessages],
  );

  const onSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void sendTurn({ text }, text);
  }, [input, sendTurn]);

  const onButton = useCallback(
    (id: string, title: string) => {
      void sendTurn({ buttonId: id }, title);
    },
    [sendTurn],
  );

  const closeWidget = useCallback(() => {
    if (typeof window !== "undefined") {
      window.parent?.postMessage({ type: "smrtbot:close" }, "*");
    }
  }, []);

  const header = useMemo(
    () => (
      <div className="flex items-center justify-between px-4 py-3 text-white" style={{ backgroundColor: accent }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20">
            <MessageSquareText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">{botName}</div>
            <div className="truncate text-xs opacity-80 leading-tight">{labels.headerSubtitle}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={closeWidget}
          aria-label={labels.closeLabel}
          className="rounded-full p-1 transition hover:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    ),
    [accent, botName, labels.headerSubtitle, labels.closeLabel, closeWidget],
  );

  return (
    <div dir={dir} className="flex h-full w-full flex-col bg-slate-50 text-slate-900">
      {header}

      {phase === "form" ? (
        <div className="flex flex-1 flex-col justify-center gap-4 overflow-y-auto px-5 py-6">
          <div>
            <h2 className="text-lg font-semibold">{labels.formTitle}</h2>
            <p className="text-sm text-slate-500">{labels.formSubtitle}</p>
          </div>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{labels.nameLabel}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={labels.namePlaceholder}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{labels.emailLabel}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={labels.emailPlaceholder}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{labels.phoneLabel}</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={labels.phonePlaceholder}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <button
            type="button"
            onClick={startSession}
            disabled={starting}
            className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60"
            style={{ backgroundColor: accent }}
          >
            {starting ? labels.starting : labels.startButton}
          </button>
          <p className="text-center text-xs text-slate-400">{labels.privacyNote}</p>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} accent={accent} onButton={onButton} />
            ))}
            {error && <p className="text-center text-xs text-red-500">{error}</p>}
          </div>
          <div className="flex items-end gap-2 border-t border-slate-200 bg-white px-3 py-2.5">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={labels.inputPlaceholder}
              className="max-h-28 flex-1 resize-none rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
            <button
              type="button"
              onClick={onSend}
              aria-label={labels.send}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition disabled:opacity-50"
              style={{ backgroundColor: accent }}
              disabled={!input.trim()}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </>
      )}

      <div className="bg-white pb-1 text-center text-[10px] text-slate-300">{labels.poweredBy}</div>
    </div>
  );
}

function MessageBubble({
  m,
  accent,
  onButton,
}: {
  m: WebMessage;
  accent: string;
  onButton: (id: string, title: string) => void;
}) {
  const isUser = m.direction === "in";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
          isUser ? "rounded-br-sm text-white" : "rounded-bl-sm bg-white text-slate-800"
        }`}
        style={isUser ? { backgroundColor: accent } : undefined}
      >
        {m.kind === "image" && m.payload.url ? (
          <div className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.payload.url} alt={m.payload.caption ?? ""} className="max-w-full rounded-lg" />
            {m.payload.caption && <div>{renderRich(m.payload.caption)}</div>}
          </div>
        ) : (
          <div>{renderRich(m.body)}</div>
        )}
      </div>

      {m.kind === "buttons" && m.payload.buttons && m.payload.buttons.length > 0 && (
        <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1.5">
          {m.payload.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => onButton(b.id, b.title)}
              className="rounded-full border px-3 py-1.5 text-sm font-medium transition hover:bg-slate-50"
              style={{ borderColor: accent, color: accent }}
            >
              {b.title}
            </button>
          ))}
        </div>
      )}

      {m.kind === "list" && m.payload.rows && m.payload.rows.length > 0 && (
        <div className="mt-1.5 flex w-[85%] flex-col gap-1.5">
          {m.payload.rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onButton(r.id, r.title)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-start text-sm transition hover:bg-slate-50"
            >
              <div className="font-medium text-slate-800">{r.title}</div>
              {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
