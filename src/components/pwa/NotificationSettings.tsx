"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Bell, BellOff, BellRing, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/lib/pwa/push";

/**
 * Push-notification management card for the Account page. Lets the user turn
 * OS-level notifications on/off and fire a test — the entire notification
 * experience is controlled from inside smrtesy.
 */
export function NotificationSettings() {
  const t = useTranslations("pushSettings");
  const { supported, permission, subscribed, busy, unavailable, enable, disable, sendTest } =
    usePushNotifications();

  const handleEnable = async () => {
    try {
      await enable();
      // Permission may have been denied inside enable(); reflect that.
      if (Notification.permission === "granted") {
        toast.success(t("enabled"));
      } else if (Notification.permission === "denied") {
        toast.error(t("blocked"));
      }
    } catch {
      toast.error(unavailable ? t("unavailable") : t("error"));
    }
  };

  const handleDisable = async () => {
    try {
      await disable();
      toast.success(t("disabled"));
    } catch {
      toast.error(t("error"));
    }
  };

  const handleTest = async () => {
    try {
      await sendTest();
      toast.success(t("testSent"));
    } catch {
      toast.error(t("error"));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("description")}</p>

        {!supported ? (
          // No PushManager — most often iOS Safari before "Add to Home Screen".
          <p className="text-sm text-status-warn">{t("installFirst")}</p>
        ) : permission === "denied" ? (
          <p className="text-sm text-status-warn">{t("blocked")}</p>
        ) : subscribed ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-ok">
              <BellRing className="h-4 w-4" />
              {t("on")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleTest}
              disabled={busy}
            >
              <Send className="h-3.5 w-3.5" />
              {t("test")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleDisable}
              disabled={busy}
            >
              <BellOff className="h-3.5 w-3.5" />
              {t("turnOff")}
            </Button>
          </div>
        ) : (
          <Button onClick={handleEnable} disabled={busy} className="gap-2 min-h-[44px]">
            <Bell className="h-4 w-4" />
            {t("turnOn")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
