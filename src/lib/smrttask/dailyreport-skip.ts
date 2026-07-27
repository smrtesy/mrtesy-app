import { api } from "@/lib/api/client";

/**
 * Dismiss / restore a daily-report fill-day, SERIALIZED.
 *
 * `POST /daily-report/skip` does a read-modify-write of the whole
 * `user_settings.day_tools` blob, so two writes in flight at once make the last
 * one win — dismissing three missed days by clicking X three times would persist
 * only one, and the other rows would come back on the next refresh even though
 * the UI said they were gone. Every caller goes through this one queue so the
 * writes are strictly ordered.
 *
 * (Two browser tabs can still race; the per-tool merge in PATCH /me/settings
 * keeps that from destroying unrelated settings, and a refresh reconciles.)
 */
let chain: Promise<unknown> = Promise.resolve();

export function setDaySkipped(fillDate: string, skipped: boolean): Promise<void> {
  // A rejected predecessor must not poison the queue for everyone behind it.
  const run = chain
    .catch(() => undefined)
    .then(() => api("/api/daily-report/skip", { method: "POST", body: { fill_date: fillDate, skipped } }));
  chain = run;
  return run.then(() => undefined);
}
