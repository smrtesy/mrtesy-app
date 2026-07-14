"use client";

import { useCallback, useEffect, useState } from "react";
import { PaneLink } from "@/lib/panes/nav";
import { useLocale, useTranslations } from "next-intl";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api/client";
import { SmrtBotIcon } from "@/components/icons/SmrtBotIcon";

import { BotFormDialog } from "./BotFormDialog";

interface Bot {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  timezone: string | null;
  live_phone_display: string | null;
}

export function BotsClient() {
  const t = useTranslations("smrtBot");
  const locale = useLocale();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchBots = useCallback(async () => {
    try {
      const { bots } = await api<{ bots: Bot[] }>("/api/bot/bots");
      setBots(bots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <BotFormDialog onCreated={fetchBots} />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {bots === null && !error && (
        <p className="text-sm text-muted-foreground">…</p>
      )}

      {bots !== null && bots.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <SmrtBotIcon className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">{t("emptyState")}</p>
        </div>
      )}

      {bots !== null && bots.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <PaneLink key={bot.id} href={`/${locale}/bots/${bot.id}`}>
              <Card className="h-full transition-colors hover:border-primary">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">{bot.name}</CardTitle>
                  <Badge
                    className={
                      bot.active
                        ? "bg-status-ok-bg text-status-ok"
                        : "bg-muted text-muted-foreground"
                    }
                  >
                    {bot.active ? t("active") : t("inactive")}
                  </Badge>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <div dir="ltr" className="truncate">/{bot.slug}</div>
                  {bot.live_phone_display && (
                    <div dir="ltr" className="truncate">{bot.live_phone_display}</div>
                  )}
                </CardContent>
              </Card>
            </PaneLink>
          ))}
        </div>
      )}
    </div>
  );
}
