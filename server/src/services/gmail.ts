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

export async function createDraft(
  userId: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
): Promise<{ id: string; link: string }> {
  const gmail = await getGmailClient(userId);

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
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
