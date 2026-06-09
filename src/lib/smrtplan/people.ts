/**
 * personLabel — how a teammate is shown across the app.
 *
 * Priority: the org admin's explicit `display_name` → otherwise the FIRST name
 * from the auth full name (tasks usually want just the first name) → otherwise
 * the full name / email / a short id. The admin sets `display_name` (e.g. adds a
 * last-name initial) to disambiguate two people who share a first name.
 */

export interface Person {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
  display_name?: string | null;
}

export function firstName(name?: string | null): string | null {
  const n = name?.trim();
  if (!n) return null;
  return n.split(/\s+/)[0];
}

export function personLabel(p: Person | undefined | null): string {
  if (!p) return "—";
  return (
    p.display_name?.trim() ||
    firstName(p.name) ||
    p.name?.trim() ||
    p.email?.trim() ||
    (p.user_id ? p.user_id.slice(0, 6) : "—")
  );
}
