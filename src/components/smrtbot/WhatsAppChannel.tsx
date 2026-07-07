"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, LogOut, Send, Trash2, ShieldCheck } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api/client";

interface Session {
  status: "connecting" | "qr" | "open" | "closed";
  last_qr?: string | null;
  connected_phone?: string | null;
  connected_at?: string | null;
  last_error?: string | null;
}

interface Group {
  group_jid: string;
  subject: string;
  is_community: boolean;
  is_admin: boolean;
  participants_count: number;
  last_synced_at: string;
}

interface Broadcast {
  id: string;
  target_jid: string;
  body_text: string;
  scheduled_at: string;
  status: "pending" | "sending" | "sent" | "failed" | "canceled";
  error?: string | null;
  source: string;
}

/** Unofficial WhatsApp (Baileys) channel: pair, sync groups, schedule broadcasts. */
export function WhatsAppChannel({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [session, setSession] = useState<Session | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [busy, setBusy] = useState(false);

  // Schedule form.
  const [targetJid, setTargetJid] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const { session } = await api<{ session: Session }>(`/api/bot/bots/${botId}/wa/status`);
      setSession(session);
    } catch {
      /* transient — keep last known state */
    }
  }, [botId]);

  const loadGroups = useCallback(async () => {
    try {
      const { groups } = await api<{ groups: Group[] }>(`/api/bot/bots/${botId}/wa/groups`);
      setGroups(groups);
    } catch {
      /* ignore */
    }
  }, [botId]);

  const loadBroadcasts = useCallback(async () => {
    try {
      const { broadcasts } = await api<{ broadcasts: Broadcast[] }>(`/api/bot/bots/${botId}/broadcasts`);
      setBroadcasts(broadcasts);
    } catch {
      /* ignore */
    }
  }, [botId]);

  // Initial load + poll the connection status while pairing/connecting.
  useEffect(() => {
    void loadStatus();
    void loadGroups();
    void loadBroadcasts();
  }, [loadStatus, loadGroups, loadBroadcasts]);

  const status = session?.status ?? "closed";
  const pollRef = useRef(status);
  pollRef.current = status;
  useEffect(() => {
    // Skip polls while the tab is hidden (a background tab otherwise polls
    // around the clock); refresh immediately when the user comes back.
    const shouldPoll = () => pollRef.current === "qr" || pollRef.current === "connecting";
    const id = setInterval(() => {
      if (!document.hidden && shouldPoll()) void loadStatus();
    }, 4000);
    const handleVisibility = () => {
      if (!document.hidden && shouldPoll()) void loadStatus();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadStatus]);

  const connect = async () => {
    setBusy(true);
    try {
      const { session } = await api<{ session: Session }>(`/api/bot/bots/${botId}/wa/connect`, { method: "POST" });
      setSession(session);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("waConnectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api(`/api/bot/bots/${botId}/wa/logout`, { method: "POST" });
      await loadStatus();
      toast.success(t("waLoggedOut"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const syncGroups = async () => {
    setBusy(true);
    try {
      const { synced } = await api<{ synced: number }>(`/api/bot/bots/${botId}/wa/groups/sync`, { method: "POST" });
      await loadGroups();
      toast.success(t("waGroupsSynced", { count: synced }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const createBroadcast = async () => {
    if (!targetJid || !bodyText.trim() || !scheduledAt) {
      toast.error(t("waBroadcastIncomplete"));
      return;
    }
    setBusy(true);
    try {
      await api(`/api/bot/bots/${botId}/broadcasts`, {
        method: "POST",
        body: {
          target_jid: targetJid,
          target_type: "group",
          body_text: bodyText,
          scheduled_at: new Date(scheduledAt).toISOString(),
        },
      });
      setBodyText("");
      setScheduledAt("");
      await loadBroadcasts();
      toast.success(t("waBroadcastScheduled"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const deleteBroadcast = async (id: string) => {
    try {
      await api(`/api/bot/bots/${botId}/broadcasts/${id}`, { method: "DELETE" });
      await loadBroadcasts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const statusColor =
    status === "open" ? "bg-green-500" : status === "qr" || status === "connecting" ? "bg-amber-500" : "bg-muted-foreground";

  return (
    <div className="space-y-6">
      {/* Connection */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor}`} />
              <span className="font-medium">{t(`waStatus_${status}`)}</span>
              {session?.connected_phone && (
                <span className="text-sm text-muted-foreground">{session.connected_phone}</span>
              )}
            </div>
            <div className="flex gap-2">
              {status !== "open" && (
                <Button size="sm" onClick={connect} disabled={busy}>
                  {t("waConnect")}
                </Button>
              )}
              {status !== "closed" && (
                <Button size="sm" variant="outline" onClick={logout} disabled={busy}>
                  <LogOut className="me-1 h-4 w-4" />
                  {t("waLogout")}
                </Button>
              )}
            </div>
          </div>

          {status === "qr" && session?.last_qr && (
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={session.last_qr} alt="WhatsApp QR" className="h-64 w-64" />
              <p className="text-sm text-muted-foreground">{t("waScanHint")}</p>
            </div>
          )}

          {session?.last_error && status !== "open" && (
            <p className="text-sm text-destructive">{session.last_error}</p>
          )}

          <p className="text-xs text-muted-foreground">{t("waUnofficialWarning")}</p>
        </CardContent>
      </Card>

      {/* Groups */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("waGroupsTitle")}</h2>
            <Button size="sm" variant="outline" onClick={syncGroups} disabled={busy || status !== "open"}>
              <RefreshCw className="me-1 h-4 w-4" />
              {t("waSyncGroups")}
            </Button>
          </div>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("waNoGroups")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((g) => (
                <li key={g.group_jid} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium">{g.subject || g.group_jid}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("waMembers", { count: g.participants_count })}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {g.is_community && <Badge variant="secondary">{t("waCommunity")}</Badge>}
                    {g.is_admin && (
                      <Badge>
                        <ShieldCheck className="me-1 h-3 w-3" />
                        {t("waAdmin")}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Schedule a broadcast */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="font-semibold">{t("waScheduleTitle")}</h2>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("waTargetGroup")}</label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={targetJid}
              onChange={(e) => setTargetJid(e.target.value)}
            >
              <option value="">{t("waSelectGroup")}</option>
              {groups
                .filter((g) => g.is_admin)
                .map((g) => (
                  <option key={g.group_jid} value={g.group_jid}>
                    {g.subject || g.group_jid}
                  </option>
                ))}
            </select>
          </div>
          <Textarea
            placeholder={t("waMessagePlaceholder")}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={4}
          />
          <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          <Button onClick={createBroadcast} disabled={busy}>
            <Send className="me-1 h-4 w-4" />
            {t("waSchedule")}
          </Button>
        </CardContent>
      </Card>

      {/* Scheduled / sent broadcasts */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="font-semibold">{t("waBroadcastsTitle")}</h2>
          {broadcasts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("waNoBroadcasts")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {broadcasts.map((b) => (
                <li key={b.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{b.body_text}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(b.scheduled_at).toLocaleString()} · {t(`waBStatus_${b.status}`)}
                      {b.error ? ` · ${b.error}` : ""}
                    </div>
                  </div>
                  {(b.status === "pending" || b.status === "failed" || b.status === "canceled") && (
                    <button
                      onClick={() => deleteBroadcast(b.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t("waDelete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
