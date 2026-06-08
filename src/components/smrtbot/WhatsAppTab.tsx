"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { MetaCredentialsForm } from "./MetaCredentialsForm";
import { WhatsAppChannel } from "./WhatsAppChannel";

/** The bot's WhatsApp connection — transport-aware. Official (Meta) shows the
 *  Cloud-API credentials; unofficial (Baileys) shows the QR pairing + groups +
 *  broadcasts. A switch flips the bot between the two. */
export function WhatsAppTab({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [transport, setTransport] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    try {
      const { bot } = await api<{ bot: { transport: string | null } }>(`/api/bot/bots/${botId}`);
      setTransport(bot.transport ?? "meta");
    } catch {
      setTransport("meta");
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = useCallback(
    async (next: "meta" | "baileys") => {
      setSwitching(true);
      try {
        await api(`/api/bot/bots/${botId}`, { method: "PATCH", body: { transport: next } });
        setTransport(next);
        toast.success(next === "baileys" ? t("waSwitched") : t("waSwitchedMeta"));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        setSwitching(false);
      }
    },
    [botId, t],
  );

  if (transport === null) return <p className="text-sm text-muted-foreground">…</p>;

  const isBaileys = transport === "baileys";

  return (
    <div className="space-y-4">
      {/* Transport indicator + switch */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <div className="text-sm font-medium">
              {isBaileys ? t("transportBaileys") : t("transportMeta")}
            </div>
            <div className="text-xs text-muted-foreground">
              {isBaileys ? t("transportBaileysHint") : t("transportMetaHint")}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={switching}
            onClick={() => switchTo(isBaileys ? "meta" : "baileys")}
          >
            {isBaileys ? t("waSwitchToMeta") : t("waSwitchToBaileys")}
          </Button>
        </CardContent>
      </Card>

      {isBaileys ? <WhatsAppChannel botId={botId} /> : <MetaCredentialsForm botId={botId} />}
    </div>
  );
}
