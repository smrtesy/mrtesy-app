/**
 * PART 1 — Email + Drive + Calendar Collector
 *
 * Collects new items from Gmail, Google Drive (ScanSnap folder), and Calendar,
 * writes them to source_messages with processing_status='pending' for PART 3.
 * Uses sync_state.checkpoint to avoid reprocessing.
 */

import { db, createRunSession, closeRunSession, updateSyncState, loadRules } from "../../../db";
import { searchGmail, getMessage, extractEmailText, getThreadMessages } from "../../../services/gmail";
import { listNewFiles, getFileContent } from "../../../services/drive";
import { listEvents, listCalendars } from "../../../services/calendar";
import { parseSkipRules, parseCalendarSkips } from "../lib/rule-filters";

export interface Part1Options {
  userId: string;
  /** Override Gmail lookback in days. Falls back to user_settings.initial_scan_days_back or 7. */
  gmailDays?: number;
  /** Override Drive lookback in hours (default: since last sync or 24h) */
  driveHours?: number;
  /** Override Calendar lookback in months. Falls back to user_settings.calendar_initial_scan_months or 1. */
  calMonths?: number;
  /** Override Drive folder. Falls back to user_settings.drive_folder_id. */
  driveFolderId?: string | null;
}

export async function runPart1(opts: Part1Options): Promise<{ sessionId: string }> {
  const { userId, gmailDays, driveHours, calMonths, driveFolderId } = opts;
  const sessionId = await createRunSession(userId, "part1", "collector");

  // Load per-user settings once; sub-scans share these.
  const { data: settings } = await db
    .from("user_settings")
    .select("calendar_initial_scan_months, initial_scan_days_back, drive_folder_id")
    .eq("user_id", userId)
    .maybeSingle();

  const effectiveGmailDays = gmailDays ?? (settings?.initial_scan_days_back as number | undefined) ?? 7;
  const effectiveCalMonths = calMonths ?? (settings?.calendar_initial_scan_months as number | undefined) ?? 1;
  const effectiveDriveFolder = driveFolderId ?? (settings?.drive_folder_id as string | null | undefined) ?? null;

  const errors: string[] = [];
  let itemsProcessed = 0;

  try {
    // Load skip rules from rules_memory (single source of truth, managed via /admin/rules)
    const rules = await loadRules(userId);
    const skipFilter = parseSkipRules(rules);

    // Load sync checkpoints
    const { data: syncStates } = await db
      .from("sync_state")
      .select("source, checkpoint, last_synced_at")
      .eq("user_id", userId)
      .in("source", ["gmail", "drive", "calendar"]);

    const checkpoint = (source: string) =>
      syncStates?.find((s) => s.source === source)?.last_synced_at ?? null;

    // ── 1. Gmail ──────────────────────────────────────────────────────────────
    // One Gmail OAuth = one inbox. We scan everything in that inbox (subject to
    // skip rules and the lookback window). The per-alias `deliveredto:` loop
    // that lived here previously was a relic from the single-tenant build.
    try {
      // Lookback priority:
      //   1. Explicit `gmailDays` from caller (onboarding/resync — user
      //      just chose a window and expects that window to be honored).
      //   2. Stored checkpoint (incremental sync after the first scan).
      //   3. `user_settings.initial_scan_days_back` or hard default.
      // Without step 1 taking precedence, a stale sync_state row from a
      // previous scan would silently shorten the user's chosen window.
      const lastGmailSync = checkpoint("gmail");
      const since = gmailDays != null
        ? new Date(Date.now() - gmailDays * 24 * 60 * 60 * 1000)
        : lastGmailSync
          ? new Date(lastGmailSync)
          : new Date(Date.now() - effectiveGmailDays * 24 * 60 * 60 * 1000);

      const afterDate = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}`;

      // `in:inbox` is essential: without it, Gmail's `q` searches ALL labels,
      // pulling Sent/Chats/Archive into source_messages and creating
      // "reply-to-yourself" task suggestions from the user's own outbound mail.
      const query = [
        `after:${afterDate}`,
        `in:inbox`,
        ...skipFilter.gmailQueryFilters,
        `-in:drafts`,
      ].join(" ");

      const messages = await searchGmail(userId, query, 100);

      for (const { id, threadId } of messages) {
        try {
          const msg = await getMessage(userId, id);
          const { subject, from, to, date, body } = extractEmailText(
            msg as Parameters<typeof extractEmailText>[0],
          );

          // `[^>]+` is non-greedy across angle-bracket pairs; the greedy
          // `.+` form swallowed everything between the first `<` and the
          // LAST `>` on multi-recipient headers, producing garbage like
          // `alice@a.com>, "Bob" <bob@b.com`.
          const fromEmail = (from.match(/<([^>]+)>/) ?? [])[1] ?? from;

          // If this is a reply (has In-Reply-To header), fetch thread history so
          // Part3 sees the full conversation context, not just the last message.
          const headers: { name?: string | null; value?: string | null }[] =
            ((msg as { payload?: { headers?: { name?: string | null; value?: string | null }[] } })
              .payload?.headers ?? []);
          const isReply = headers.some(
            (h) => h.name?.toLowerCase() === "in-reply-to",
          );
          // RFC 2822 Message-ID — unique per email, works in Gmail search URL.
          // Strip angle brackets (<msg-id@host> → msg-id@host).
          const rfc822MsgId = headers
            .find((h) => h.name?.toLowerCase() === "message-id")
            ?.value?.replace(/^<|>$/g, "")
            .trim() ?? null;

          let threadContext = "";
          if (isReply) {
            try {
              const prior = await getThreadMessages(userId, threadId, 3);
              // Exclude the current message (last in the thread) — it's already in body
              const history = prior.slice(0, -1);
              if (history.length > 0) {
                threadContext =
                  "\n\n--- THREAD HISTORY (oldest first) ---\n" +
                  history
                    .map((m) => `[${m.date}] From: ${m.from}\n${m.snippet}`)
                    .join("\n\n");
              }
            } catch {
              // Thread fetch failing is non-fatal; classify without context
            }
          }

          const rawContent = `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}${threadContext}`.slice(0, 3000);

          // Derive the actual recipient alias from the To: header so the
          // classifier has it without the collector having to loop on aliases.
          // Same non-greedy fix as fromEmail above; multi-recipient To:
          // headers would otherwise produce concatenated garbage.
          const toEmail = (to.match(/<([^>]+)>/) ?? [])[1] ?? to.trim();

          const { error: gmailUpsertErr } = await db.from("source_messages").upsert(
            {
              user_id: userId,
              source_type: "gmail",
              source_id: id,
              sender: from,
              sender_email: fromEmail,
              subject,
              body_text: body.slice(0, 1000),
              raw_content: rawContent,
              received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
              processing_status: "pending",
              reply_to_context: toEmail,
              // Use Gmail search-by-Message-ID so the URL survives mobile redirects.
              // rfc822msgid:<id> is guaranteed unique; falls back to #all/<id> if
              // the header is missing.
              source_url: rfc822MsgId
                ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(rfc822MsgId)}`
                : `https://mail.google.com/mail/u/0/#all/${id}`,
              metadata: { threadId, to: toEmail },
            },
            { onConflict: "user_id,source_type,source_id" },
          );
          if (gmailUpsertErr) throw new Error(gmailUpsertErr.message);
          itemsProcessed++;
        } catch (e) {
          errors.push(`gmail msg ${id}: ${e}`);
        }
      }

      await updateSyncState(userId, "gmail", new Date().toISOString());
    } catch (e) {
      errors.push(`gmail: ${e}`);
    }

    // ── 2. Google Drive (ScanSnap) ────────────────────────────────────────────
    try {
      // Same explicit-overrides-checkpoint pattern as Gmail above.
      const lastDriveSync = checkpoint("drive");
      const since = driveHours != null
        ? new Date(Date.now() - driveHours * 60 * 60 * 1000)
        : lastDriveSync
          ? new Date(lastDriveSync)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);

      const files = await listNewFiles(userId, since.toISOString(), effectiveDriveFolder);

      for (const file of files) {
        if (!file.id || !file.name) continue;
        try {
          let content = "";
          if (file.mimeType?.includes("document") || file.mimeType?.includes("pdf")) {
            content = await getFileContent(userId, file.id);
          }

          const rawContent = `File: ${file.name}\nType: ${file.mimeType}\nModified: ${file.modifiedTime}\n\n${content}`.slice(0, 3000);

          const { error: driveUpsertErr } = await db.from("source_messages").upsert(
            {
              user_id: userId,
              source_type: "google_drive",
              source_id: file.id,
              subject: file.name,
              body_text: content.slice(0, 1000),
              raw_content: rawContent,
              received_at: file.modifiedTime ?? new Date().toISOString(),
              processing_status: "pending",
              source_url: (file as { webViewLink?: string | null }).webViewLink
                ?? `https://drive.google.com/file/d/${file.id}/view`,
              metadata: { mimeType: file.mimeType, size: file.size },
            },
            { onConflict: "user_id,source_type,source_id" },
          );
          if (driveUpsertErr) throw new Error(driveUpsertErr.message);
          itemsProcessed++;
        } catch (e) {
          errors.push(`drive file ${file.id}: ${e}`);
        }
      }

      await updateSyncState(userId, "drive", new Date().toISOString());
    } catch (e) {
      errors.push(`drive: ${e}`);
    }

    // ── 3. Google Calendar ────────────────────────────────────────────────────
    try {
      const now = new Date();
      // Symmetric window: lookback AND lookahead both use the user's
      // onboarding choice. The UI labels read "±N months" and the helper
      // text promises "up to N months ahead" — both directions must match.
      const windowMs = effectiveCalMonths * 30 * 24 * 60 * 60 * 1000;
      const timeMin = new Date(now.getTime() - windowMs).toISOString();
      const timeMax = new Date(now.getTime() + windowMs).toISOString();

      const calendarSkips = parseCalendarSkips(rules);

      let calendarIds: string[];
      try {
        const allCalendars = await listCalendars(userId);
        calendarIds = allCalendars
          .filter((c) => !calendarSkips.has(c.id))
          .map((c) => c.id);
        if (calendarIds.length === 0) calendarIds = ["primary"];
      } catch {
        calendarIds = ["primary"];
      }

      const seenIds = new Set<string>();

      for (const calendarId of calendarIds) {
        let calEvents;
        try {
          calEvents = await listEvents(userId, timeMin, timeMax, 100, calendarId);
        } catch {
          continue;
        }

        for (const event of calEvents) {
          if (!event.id || seenIds.has(event.recurringEventId ?? event.id)) continue;
          seenIds.add(event.recurringEventId ?? event.id);

          const hasAttendees = (event.attendees?.length ?? 0) > 1;

          const attendeeList =
            event.attendees?.map((a) => `${a.displayName ?? ""} <${a.email}>`).join(", ") ?? "";
          const isPast = new Date(event.start?.dateTime ?? event.start?.date ?? "") < now;

          const rawContent = [
            `Event: ${event.summary}`,
            `Date: ${event.start?.dateTime ?? event.start?.date}`,
            `Location: ${event.location ?? ""}`,
            `Attendees: ${attendeeList}`,
            isPast ? "NOTE: Past event — follow-up candidate" : "",
            `Description: ${event.description ?? ""}`,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 3000);

          const { error: calUpsertErr } = await db.from("source_messages").upsert(
            {
              user_id: userId,
              source_type: "google_calendar",
              source_id: event.id,
              subject: event.summary ?? "Untitled event",
              body_text: event.description?.slice(0, 1000) ?? "",
              raw_content: rawContent,
              received_at: event.start?.dateTime ?? event.start?.date ?? new Date().toISOString(),
              processing_status: "pending",
              reply_to_context: isPast ? "follow-up after meeting" : `${hasAttendees ? event.attendees?.length : 1} attendees`,
              source_url: event.htmlLink ?? null,
              metadata: { eventId: event.id, recurringEventId: event.recurringEventId, isPast, hasAttendees },
            },
            { onConflict: "user_id,source_type,source_id" },
          );
          if (calUpsertErr) throw new Error(calUpsertErr.message);
          itemsProcessed++;
        }
      }

      await updateSyncState(userId, "calendar", new Date().toISOString());
    } catch (e) {
      errors.push(`calendar: ${e}`);
    }

    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      { items_processed: itemsProcessed, errors_count: errors.length },
      `Collected ${itemsProcessed} items. ${errors.length} errors.`,
      errors,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeRunSession(sessionId, "failed", { errors_count: 1 }, `Fatal: ${msg}`, [msg]);
    throw err;
  }

  return { sessionId };
}
