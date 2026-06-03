/**
 * smrtCRM — request/response types shared across routes and the contacts service.
 */

export type ContactSource = "manual" | "csv" | "bot" | "api" | "migration";

export interface ContactInput {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  custom_fields?: Record<string, unknown>;
  source?: ContactSource;
}

export interface UpsertResult {
  id: string;
  /** "created" = new row inserted; "merged" = matched an existing contact and filled gaps. */
  outcome: "created" | "merged";
}

export interface ImportRow extends ContactInput {
  [key: string]: unknown;
}
