/**
 * smrtReach — Amazon SES client.
 *
 * Sends a single email through SES in a given region. AWS credentials are read
 * at runtime from app_secrets (slug "smrtreach") via getAppSecret — they are
 * NEVER hardcoded or imported. The region is passed in (resolved per content
 * language by the send-service), and the from-address comes from the org's
 * managed sender list — nothing here is locked to one address or one region.
 *
 * Required app_secrets (managed in the admin UI):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { getAppSecret } from "../../db";

export interface SendEmailParams {
  region: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string | null;
}

export class SesNotConfiguredError extends Error {}

// Cache one client per region for the life of the process (credentials are
// fetched once per region here; getAppSecret itself also caches briefly).
const clientCache = new Map<string, SESClient>();

async function getClient(region: string): Promise<SESClient> {
  const cached = clientCache.get(region);
  if (cached) return cached;

  const accessKeyId = await getAppSecret("smrtreach", "AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
  const secretAccessKey = await getAppSecret("smrtreach", "AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new SesNotConfiguredError(
      "SES credentials not set. Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to app_secrets (slug smrtreach).",
    );
  }

  const client = new SESClient({ region, credentials: { accessKeyId, secretAccessKey } });
  clientCache.set(region, client);
  return client;
}

/** Clear cached clients (call after rotating credentials). */
export function resetSesClients(): void {
  clientCache.clear();
}

export async function sendEmail(p: SendEmailParams): Promise<{ messageId: string }> {
  const client = await getClient(p.region);
  const res = await client.send(
    new SendEmailCommand({
      Source: p.from,
      Destination: { ToAddresses: [p.to] },
      Message: {
        Subject: { Data: p.subject, Charset: "UTF-8" },
        Body: { Html: { Data: p.html, Charset: "UTF-8" } },
      },
      ReplyToAddresses: p.replyTo ? [p.replyTo] : undefined,
    }),
  );
  return { messageId: res.MessageId ?? "" };
}
