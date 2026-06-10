"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { api } from "@/lib/api/client";
import { personLabel } from "@/lib/smrtplan/people";
import { cn } from "@/lib/utils";

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
}
interface Capacity {
  user_id: string;
  work_days: number[];
  hours_per_day: number;
}

const DEFAULT_DAYS = [0, 1, 2, 3, 4];
const DEFAULT_HOURS = 8;

function memberName(m: Member) {
  return personLabel(m);
}

/** Per-worker capacity (work days + hours/day) — rendered inside the
 *  plan-settings hub. Loads on mount. */
export function CapacitySection() {
  const t = useTranslations("smrtPlan.capacity");
  const days = (t.raw("days") as string[]) ?? ["0", "1", "2", "3", "4", "5", "6"];
  const [members, setMembers] = useState<Member[]>([]);
  const [rows, setRows] = useState<Record<string, Capacity>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ members }, { capacity }] = await Promise.all([
          api<{ members: Member[] }>("/api/org/members"),
          api<{ capacity: Capacity[] }>("/api/plan/capacity"),
        ]);
        if (!alive) return;
        const byUser: Record<string, Capacity> = {};
        for (const m of members ?? []) {
          byUser[m.user_id] = { user_id: m.user_id, work_days: DEFAULT_DAYS, hours_per_day: DEFAULT_HOURS };
        }
        for (const c of capacity ?? []) {
          byUser[c.user_id] = { user_id: c.user_id, work_days: c.work_days ?? DEFAULT_DAYS, hours_per_day: c.hours_per_day ?? DEFAULT_HOURS };
        }
        setMembers(members ?? []);
        setRows(byUser);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function toggleDay(userId: string, day: number) {
    setRows((r) => {
      const cur = r[userId];
      const has = cur.work_days.includes(day);
      const work_days = has ? cur.work_days.filter((d) => d !== day) : [...cur.work_days, day].sort();
      return { ...r, [userId]: { ...cur, work_days } };
    });
  }
  function setHours(userId: string, hours: number) {
    setRows((r) => ({ ...r, [userId]: { ...r[userId], hours_per_day: hours } }));
  }

  async function save(userId: string) {
    const cur = rows[userId];
    setSavingId(userId);
    try {
      await api(`/api/plan/capacity/${userId}`, {
        method: "PUT",
        body: { work_days: cur.work_days, hours_per_day: cur.hours_per_day },
      });
      toast.success(t("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted-foreground">{t("hint")}</p>

      {loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="space-y-2">
          {members.map((m) => {
            const cap = rows[m.user_id];
            if (!cap) return null;
            return (
              <div key={m.user_id} className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
                <span className="w-32 flex-shrink-0 truncate text-[13px] font-medium" title={memberName(m)}>
                  {memberName(m)}
                </span>
                <div className="flex gap-1">
                  {days.map((label, day) => {
                    const on = cap.work_days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(m.user_id, day)}
                        className={cn(
                          "h-7 w-7 rounded-md border text-[11px] font-bold transition-colors",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background text-muted-foreground hover:bg-accent",
                        )}
                        title={label}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  {t("hoursPerDay")}
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={cap.hours_per_day}
                    onChange={(e) => setHours(m.user_id, Number(e.target.value))}
                    className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <button
                  onClick={() => save(m.user_id)}
                  disabled={savingId === m.user_id}
                  className="ms-auto inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> {t("save")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
