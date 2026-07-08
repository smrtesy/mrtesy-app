"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { CalendarClock, MapPin, ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface AgendaEvent {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
  source: "google" | "app";
  taskId: string | null;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * "Events" entry point that sits beside the search field. Collapsed by default
 * (an icon + a count badge for the coming week); a click opens a popover with
 * the week's events grouped by day. It auto-opens once when today has an event.
 * Always clickable regardless of the count.
 */
export function EventsPanel({ locale }: { locale: string }) {
  const t = useTranslations("events");
  const [events, setEvents] = useState<AgendaEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  const intl = locale === "he" ? "he-IL" : "en-US";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ events: AgendaEvent[] }>("/api/events?days=7");
      setEvents(data.events ?? []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-open once when today already has an event on the calendar.
  useEffect(() => {
    if (!events || autoOpenedRef.current) return;
    const today = localToday();
    if (events.some((e) => e.start.slice(0, 10) === today)) {
      setOpen(true);
      autoOpenedRef.current = true;
    }
  }, [events]);

  const count = events?.length ?? 0;

  // Group by calendar day, preserving the (already sorted) chronological order.
  const groups: { day: string; items: AgendaEvent[] }[] = [];
  for (const ev of events ?? []) {
    const day = ev.start.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(ev);
    else groups.push({ day, items: [ev] });
  }
  const today = localToday();

  function dayLabel(day: string): string {
    if (day === today) return t("today");
    const d = new Date(`${day}T00:00:00`);
    return d.toLocaleDateString(intl, { weekday: "long", day: "numeric", month: "short" });
  }

  function timeLabel(ev: AgendaEvent): string {
    if (ev.allDay) return t("allDay");
    return new Date(ev.start).toLocaleTimeString(intl, { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("button")}
          className={cn(
            "relative flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors hover:bg-accent",
            count > 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <CalendarClock className="h-4 w-4" />
          <span className="hidden sm:inline">{t("button")}</span>
          {count > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" dir={locale === "he" ? "rtl" : "ltr"}>
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold">{t("weekTitle")}</h3>
        </div>
        <div className="max-h-[60vh] overflow-auto p-2">
          {loading && !events ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("loading")}
            </div>
          ) : count === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <section key={g.day} className="space-y-1">
                  <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {dayLabel(g.day)}
                  </h4>
                  {g.items.map((ev) => {
                    const inner = (
                      <>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground" dir="ltr">
                          {timeLabel(ev)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" dir="auto">{ev.title}</span>
                          {ev.location && (
                            <span className="flex items-center gap-0.5 truncate text-[11px] text-muted-foreground" dir="auto">
                              <MapPin className="h-3 w-3 shrink-0" />{ev.location}
                            </span>
                          )}
                        </span>
                        {ev.htmlLink && <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />}
                      </>
                    );
                    const cls = "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-accent";
                    return ev.htmlLink ? (
                      <a key={ev.id} href={ev.htmlLink} target="_blank" rel="noopener noreferrer" className={cls}>
                        {inner}
                      </a>
                    ) : (
                      <div key={ev.id} className={cls}>{inner}</div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
