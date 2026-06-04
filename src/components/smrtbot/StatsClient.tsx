"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Stats {
  users: { total: number; active24h: number; active7d: number; active30d: number };
  messages: { total: number; last24h: number; last7d: number };
  game: { children: number; missions: number; trivia: number };
  questionsPending: number;
}
interface Player { child_name: string; phone: string; diamonds: number }

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export function StatsClient({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [stats, setStats] = useState<Stats | null>(null);
  const [leaderboard, setLeaderboard] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        api<Stats>(`/api/bot/${botId}/stats`),
        api<{ leaderboard: Player[] }>(`/api/bot/${botId}/stats/leaderboard`),
      ]);
      setStats(s);
      setLeaderboard(l.leaderboard);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!stats) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t("statUsers")}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label={t("statTotal")} value={stats.users.total} />
          <Metric label={t("statActive24h")} value={stats.users.active24h} />
          <Metric label={t("statActive7d")} value={stats.users.active7d} />
          <Metric label={t("statActive30d")} value={stats.users.active30d} />
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t("statMessages")}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label={t("statTotal")} value={stats.messages.total} />
          <Metric label={t("statLast24h")} value={stats.messages.last24h} />
          <Metric label={t("statLast7d")} value={stats.messages.last7d} />
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t("statGame")}</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Metric label={t("res_children")} value={stats.game.children} />
          <Metric label={t("res_missions")} value={stats.game.missions} />
          <Metric label={t("res_trivia")} value={stats.game.trivia} />
          <Metric label={t("statQuestionsPending")} value={stats.questionsPending} />
        </div>
      </div>

      {leaderboard.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">🏆 {t("statLeaderboard")}</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody>
                {leaderboard.map((p, i) => (
                  <tr key={`${p.phone}-${i}`} className="border-t border-border first:border-t-0">
                    <td className="w-10 px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2" dir="auto">{p.child_name}</td>
                    <td className="px-3 py-2 text-end">{p.diamonds} 💎</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
