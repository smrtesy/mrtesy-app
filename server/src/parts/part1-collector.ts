/**
 * PART 1 — Email + Drive + Calendar Collector
 *
 * Collects new items from Gmail, Google Drive (ScanSnap folder), and Calendar,
 * writes them to source_messages with processing_status='pending' for PART 3.
 * Uses sync_state.checkpoint to avoid reprocessing.
 */

import { db, createRunSession, closeRunSession, updateSyncState, loadRules } from "../db";
import { searchGmail, getMessage, extractEmailText } from "../services/gmail";
import { listNewFiles, getFileContent } from "../services/drive";
import { listEvents } from "../services/calendar";

const GMAIL_ACCOUNTS = ["chanoch@maor.org", "chanoch@kinus.info"];

export interface Part1Options {
  userId: string;
  /** Override lookback for Gmail in days (default: since last sync or 3 days) */
  gmailDays?: number;
  /** Override lookback for Drive in hours (default: since last sync or 24h) */
  driveHours?: number;
}

export async function runPart1(opts: Part1Options): Promise<{ sessionId: string }> {
  const { userId, gmailDays, driveHours } = opts;
  const sessionId = await createRunSession(userId, "part1", "collector");

  const errors: string[] = [];
  let itemsProcessed = 0;
  let itemsSkipped = 0;

  try {
    // Load skip rules
    const rules = await loadRules(userId);
    const skipSenders = new Set(
      rules
        .filter((r) => r.rule_type === "skip" || r.rule_type === "skip_spam")
        .map((r) => r.trigger.replace(/^(sender|from)\s*=\s*/i, "").trim().toLowerCase()),
    );

    // Load sync checkpoints
    const { data: syncStates } = await db
      .from("sync_state")
      .select("source, checkpoint, last_synced_at")
      .eq("user_id", userId)
      .in("source", ["gmail", "drive", "calendar"]);

    const checkpoint = (source: string) =>
      syncStates?.find((s) => s.source === source)?.last_synced_at ?? null;

    // ── 1. Gmail ──────────────────────────────────────────────────────────────
    try {
      const lastGmailSync = checkpoint("gmail");
      const since = lastGmailSync
        ? new Date(lastGmailSync)
        : new Date(Date.now() - (gmailDays ?? 3) * 24 * 60 * 60 * 1000);

      const afterDate = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}`;

      for (const account of GMAIL_ACCOUNTS) {
        const query = [
          `after:${afterDate}`,
          `-to:office@maor.org`,
          `-from:outbox@maor.org`,
          `-from:officetest@maor.org`,
          `-in:drafts`,
          `deliveredto:${account}`,
        ].join(" ");

        const messages = await searchGmail(userId, query, 100);

        for (const { id, threadId } of messages) {
          try {
            const msg = await getMessage(userId, id);
            const { subject, from, to, date, body } = extractEmailText(
              msg as Parameters<typeof extractEmailText>[0],
            );

            const fromEmail = (from.match(/<(.+)>/) ?? [])[1] ?? from;
            const fromLower = fromEmail.toLowerCase();

            // Hard skip rules
            if (
              skipSenders.has(fromLower) ||
              fromLower.includes("noreply") ||
              fromLower.includes("no-reply") ||
              body.toLowerCase().includes("unsubscribe")
            ) {
              itemsSkipped++;
              continue;
            }

            const rawContent = `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`.slice(0, 3000);

            await db.from("source_messages").upsert(
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
                reply_to_context: `${account}`,
                metadata: { threadId, account },
              },
              { onConflict: "user_id,source_type,source_id" },
            );
            itemsProcessed++;
          } catch (e) {
            errors.push(`gmail msg ${id}: ${e}`);
          }
        }
      }

      await updateSyncState(userId, "gmail", new Date().toISOString());
    } catch (e) {
      errors.push(`gmail: ${e}`);
    }

    // ── 2. Google Drive (ScanSnap) ────────────────────────────────────────────
    try {
      const lastDriveSync = checkpoint("drive");
      const since = lastDriveSync
        ? new Date(lastDriveSync)
        : new Date(Date.now() - (driveHours ?? 24) * 60 * 60 * 1000);

      const files = await listNewFiles(userId, since.toISOString());

      for (const file of files) {
        if (!file.id || !file.name) continue;
        try {
          let content = "";
          if (file.mimeType?.includes("document") || file.mimeType?.includes("pdf")) {
            content = await getFileContent(userId, file.id);
          }

          const rawContent = `File: ${file.name}\nType: ${file.mimeType}\nModified: ${file.modifiedTime}\n\n${content}`.slice(0, 3000);

          await db.from("source_messages").upsert(
            {
              user_id: userId,
              source_type: "drive",
              source_id: file.id,
              subject: file.name,
              body_text: content.slice(0, 1000),
              raw_content: rawContent,
              received_at: file.modifiedTime ?? new Date().toISOString(),
              processing_status: "pending",
              metadata: { mimeType: file.mimeType, size: file.size },
            },
            { onConflict: "user_id,source_type,source_id" },
          );
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
      const timeMin = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const events = await listEvents(userId, timeMin, timeMax);
      const seenIds = new Set<string>();

      for (const event of events) {
        if (!event.id || seenIds.has(event.recurringEventId ?? event.id)) continue;
        seenIds.add(event.recurringEventId ?? event.id);

        // Skip private events
        if (event.visibility === "private") continue;

        // Only events with attendees or task-like titles
        const hasAttendees = (event.attendees?.length ?? 0) > 1;
        const taskLike = /call|deadline|pay|meeting|שיחה|תשלום|פגישה/i.test(event.summary ?? "");
        if (!hasAttendees && !taskLike) continue;

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

        await db.from("source_messages").upsert(
          {
            user_id: userId,
            source_type: "calendar",
            source_id: event.id,
            subject: event.summary ?? "Untitled event",
            body_text: event.description?.slice(0, 1000) ?? "",
            raw_content: rawContent,
            received_at: event.start?.dateTime ?? event.start?.date ?? new Date().toISOString(),
            processing_status: "pending",
            reply_to_context: isPast ? "follow-up after meeting" : `${hasAttendees ? event.attendees?.length : 1} attendees`,
            metadata: { eventId: event.id, recurringEventId: event.recurringEventId, isPast, hasAttendees },
          },
          { onConflict: "user_id,source_type,source_id" },
        );
        itemsProcessed++;
      }

      await updateSyncState(userId, "calendar", new Date().toISOString());
    } catch (e) {
      errors.push(`calendar: ${e}`);
    }

    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      { items_processed: itemsProcessed, items_skipped: itemsSkipped, errors_count: errors.length },
      `Collected ${itemsProcessed} items (${itemsSkipped} skipped). ${errors.length} errors.`,
      errors,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeRunSession(sessionId, "failed", { errors_count: 1 }, `Fatal: ${msg}`, [msg]);
    throw err;
  }

  return { sessionId };
}
