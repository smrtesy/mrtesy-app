"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api, getActiveOrgId } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bell, CheckCheck, ExternalLink, Info, AlertTriangle, CheckCircle2, AlertCircle, Copy } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
interface Notification {
  id: string;
  app_slug: string;
  type: "info" | "warning" | "success" | "action_required";
  title: string;
  body: string | null;
  link: string | null;
  from_user_id: string | null;
  is_read: boolean;
  created_at: string;
}

const TYPE_CONFIG = {
  action_required: { icon: AlertCircle,   color: "text-orange-500", bg: "bg-orange-50 border-orange-200" },
  warning:         { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-50 border-yellow-200" },
  success:         { icon: CheckCircle2,  color: "text-green-500",  bg: "bg-green-50  border-green-200"  },
  info:            { icon: Info,          color: "text-blue-500",   bg: "bg-blue-50   border-blue-200"   },
} as const;

export function NotificationsList() {
  const t = useTranslations("inbox");
  const supabase = createClient();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [{ data: { user } }, orgId] = await Promise.all([
      supabase.auth.getUser(),
      getActiveOrgId(),
    ]);
    if (!user || !orgId) return;
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    setNotifications(data ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("notifications-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, load)
      .subscribe();
    const handleOrgChange = () => load();
    window.addEventListener("smrtesy:active-org-changed", handleOrgChange);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener("smrtesy:active-org-changed", handleOrgChange);
    };
  }, [supabase, load]);

  async function markRead(id: string) {
    try {
      await api<{ ok: boolean }>(`/api/inbox/notifications/${id}/read`, { method: "PATCH" });
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: true } : n));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function copyForAi(n: Notification) {
    const block = [
      `Notification: ${n.title}`,
      `App: ${n.app_slug}`,
      `Type: ${n.type}`,
      `Time: ${new Date(n.created_at).toLocaleString()}`,
      n.link ? `Link: ${n.link}` : null,
      "",
      n.body ?? "",
    ].filter((l) => l !== null).join("\n");
    try {
      await navigator.clipboard.writeText(block);
    } catch {
      const el = document.createElement("textarea");
      el.value = block;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    toast.success(t("copiedForAi"));
  }

  async function markAllRead() {
    try {
      await api<{ ok: boolean }>("/api/inbox/notifications/read-all", { method: "PATCH" });
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      toast.success(t("allMarkedRead"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
      </div>
    );
  }

  const unread = notifications.filter((n) => !n.is_read);

  return (
    <div className="space-y-3">
      {unread.length > 0 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={markAllRead}>
            <CheckCheck className="h-4 w-4" />
            {t("markAllRead")}
          </Button>
        </div>
      )}

      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <Bell className="h-10 w-10 opacity-20" />
          <p className="text-sm">{t("noNotifications")}</p>
        </div>
      ) : (
        notifications.map((n) => {
          const cfg = TYPE_CONFIG[n.type];
          const Icon = cfg.icon;
          return (
            <div
              key={n.id}
              className={`rounded-lg border p-3 transition-opacity ${n.is_read ? "opacity-60" : ""} ${!n.is_read ? cfg.bg : "bg-background"}`}
            >
              <div className="flex items-start gap-3">
                <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${cfg.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">{n.title}</p>
                    <Badge variant="outline" className="text-[10px] py-0">{n.app_slug}</Badge>
                    {!n.is_read && (
                      <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                    )}
                  </div>
                  {n.body && (
                    <p className="text-xs text-muted-foreground mt-0.5">{n.body}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {(() => {
                      const diff = Date.now() - new Date(n.created_at).getTime();
                      const mins = Math.floor(diff / 60000);
                      if (mins < 1)  return t("timeJustNow");
                      if (mins < 60) return t("timeMinsAgo", { n: mins });
                      const hrs = Math.floor(mins / 60);
                      if (hrs < 24)  return t("timeHoursAgo", { n: hrs });
                      return t("timeDaysAgo", { n: Math.floor(hrs / 24) });
                    })()}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={t("copyForAi")}
                    onClick={() => copyForAi(n)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  {n.link && (
                    <Link href={n.link}>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  )}
                  {!n.is_read && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title={t("markRead")}
                      onClick={() => markRead(n.id)}
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
