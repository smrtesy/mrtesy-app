import { google } from "googleapis";
import { getOAuthClient } from "./token-refresh";

export async function getGmailClient(userId: string) {
  const auth = await getOAuthClient(userId, "gmail_calendar");
  return google.gmail({ version: "v1", auth });
}

export async function searchGmail(
  userId: string,
  query: string,
  maxResults = 50,
): Promise<{ id: string; threadId: string }[]> {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });
  return (res.data.messages ?? []).filter((m): m is { id: string; threadId: string } =>
    typeof m.id === "string" && typeof m.threadId === "string",
  );
}

export async function getMessage(userId: string, messageId: string) {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return res.data;
}

export function extractEmailText(msg: ReturnType<typeof getMessage> extends Promise<infer T> ? T : never): {
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
} {
  const headers = (msg as { payload?: { headers?: { name: string; value: string }[] } }).payload?.headers ?? [];
  const h = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

  function extractBody(part: { mimeType?: string; body?: { data?: string }; parts?: typeof part[] }): string {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        const text = extractBody(p);
        if (text) return text;
      }
    }
    return "";
  }

  const payload = (msg as { payload?: Parameters<typeof extractBody>[0] }).payload;
  const body = payload ? extractBody(payload) : "";

  return {
    subject: h("subject"),
    from: h("from"),
    to: h("to"),
    date: h("date"),
    body: body.slice(0, 3000),
  };
}

/**
 * Fetch up to `maxMessages` most-recent messages from a Gmail thread.
 * Used to build reply context when a message has an In-Reply-To header.
 */
export async function getThreadMessages(
  userId: string,
  threadId: string,
  maxMessages = 3,
): Promise<Array<{ from: string; date: string; snippet: string }>> {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From", "Date", "Subject"],
  });

  const messages = (res.data.messages ?? []).slice(-maxMessages);
  return messages.map((m) => {
    const headers: { name?: string | null; value?: string | null }[] =
      (m as { payload?: { headers?: { name?: string | null; value?: string | null }[] } }).payload?.headers ?? [];
    const h = (name: string) =>
      headers.find((hdr) => hdr.name?.toLowerCase() === name)?.value ?? "";
    return {
      from: h("from"),
      date: h("date"),
      snippet: (m as { snippet?: string }).snippet ?? "",
    };
  });
}

/**
 * Ensure each of `names` exists as a Gmail label for the user, creating any
 * that are missing. Gmail renders a "Parent/Child" name as a nested label, so
 * passing "smrtTask/דילוג" produces a label nested under "smrtTask". Returns a
 * name → labelId map for the requested names.
 */
export async function getOrCreateLabels(
  userId: string,
  names: string[],
): Promise<Map<string, string>> {
  const gmail = await getGmailClient(userId);
  const existing = await gmail.users.labels.list({ userId: "me" });
  const byName = new Map<string, string>();
  for (const l of existing.data.labels ?? []) {
    if (l.name && l.id) byName.set(l.name, l.id);
  }
  for (const name of names) {
    if (byName.has(name)) continue;
    try {
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      if (created.data.id) byName.set(name, created.data.id);
    } catch {
      // A concurrent run may have created the label between our list and
      // create (409). Re-list once to resolve it instead of failing the
      // whole batch; if still unresolved, skip just this name.
      const refreshed = await gmail.users.labels.list({ userId: "me" });
      const match = (refreshed.data.labels ?? []).find((l) => l.name === name);
      if (match?.id) byName.set(name, match.id);
    }
  }
  return byName;
}

/** Add one label to a message. Idempotent — re-adding an existing label is a no-op. */
export async function addLabelToMessage(
  userId: string,
  messageId: string,
  labelId: string,
): Promise<void> {
  const gmail = await getGmailClient(userId);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

export async function createDraft(
  userId: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  // RFC 2822 Message-ID of the message being replied to (angle brackets
  // already stripped). When present, In-Reply-To/References make the draft a
  // proper threaded reply that Gmail shows inside the original conversation.
  inReplyTo?: string,
): Promise<{ id: string; link: string }> {
  const gmail = await getGmailClient(userId);

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(inReplyTo
      ? (() => {
          const id = inReplyTo.replace(/[\r\n]/g, "");
          return [`In-Reply-To: <${id}>`, `References: <${id}>`];
        })()
      : []),
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ];
  const raw = Buffer.from(messageParts.join("\r\n")).toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw, ...(threadId ? { threadId } : {}) },
    },
  });

  const draftId = res.data.id!;
  return {
    id: draftId,
    link: `https://mail.google.com/mail/u/0/#drafts/${draftId}`,
  };
}
