import { createHash } from "crypto";

/**
 * A short, one-way fingerprint of a secret value — used ONLY to compare "is the
 * value on provider A the same as the value on provider B / the same as the value
 * we intend" without ever storing, logging, or displaying the value itself.
 *
 * 12 hex chars of sha256 is plenty to make an accidental collision between two
 * distinct high-entropy API keys negligible, while revealing nothing about the
 * value (these are high-entropy keys, not guessable passwords).
 */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
