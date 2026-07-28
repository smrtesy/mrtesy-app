// Party identity — the code veto that stops the model inventing "same person".
//
// Every case here is a real incident or a real rescue. The T1804 pair is the
// reason the whole module exists: the classification model asserted
// "3475848008 = 972584146670" and fused two unrelated people's tasks. If that
// first test ever goes green-to-red, the veto is broken and wrong merges are
// live again.
//
// Run: deno test supabase/functions/ai-process/

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  describeParty,
  domainsRelated,
  emailDomains,
  extractEmails,
  extractPhones,
  mergeParties,
  msgPartyIds,
  partiesConflict,
  partiesMatch,
  partyIdsFrom,
  phoneKeys,
  taskPartyIds,
  taskTextNamesParty,
} from "./party-identity.ts";

Deno.test("phoneKeys: T1804 — two different numbers never key the same", () => {
  const lea = phoneKeys("3475848008");
  const mendy = phoneKeys("972584146670");
  assertEquals([...lea], ["75848008"]);
  assertEquals([...mendy], ["84146670"]);
  assertFalse(partiesMatch(partyIdsFrom([], ["3475848008"]), partyIdsFrom([], ["972584146670"])));
});

Deno.test("phoneKeys: the same number in every format anyone writes it", () => {
  const forms = ["+1-347-584-8008", "3475848008", "13475848008", "(347) 584-8008"];
  for (const f of forms) {
    assertEquals([...phoneKeys(f)], ["75848008"], `form ${f}`);
  }
});

Deno.test("phoneKeys: Israeli local vs international agree on the last 8", () => {
  // 03-123-4567 vs +972-3-123-4567 — normPhone truncates the international
  // form to 10 digits (7231234567), so only the last EIGHT digits agree. This
  // is precisely why the key is 8 and not 9.
  const local = phoneKeys("03-123-4567");
  const intl = phoneKeys("+972-3-123-4567");
  assert(local.size > 0 && intl.size > 0);
  assert([...local].some((k) => intl.has(k)));
});

Deno.test("partiesConflict: one side anonymous is UNVERIFIABLE, not a conflict", () => {
  // A calendar event or a Drive scan has no counterparty. Those are exactly the
  // cross-source links the matcher exists for, so they must still merge.
  const incoming = partyIdsFrom(["a@corp.com"], []);
  const anonymousTask = partyIdsFrom([], []);
  assertFalse(partiesConflict(incoming, anonymousTask));
  assertFalse(partiesConflict(anonymousTask, incoming));
});

Deno.test("partiesConflict: phone vs email-only is UNVERIFIABLE, not a conflict", () => {
  // One person can own both, so nothing is proven either way.
  const whatsapp = partyIdsFrom([], ["+1-347-584-8008"]);
  const emailTask = partyIdsFrom(["someone@corp.com"], []);
  assertFalse(partiesConflict(whatsapp, emailTask));
});

Deno.test("partiesConflict: comparable and different IS a conflict", () => {
  assert(partiesConflict(partyIdsFrom([], ["3475848008"]), partyIdsFrom([], ["972584146670"])));
  assert(partiesConflict(partyIdsFrom(["a@corp.com"], []), partyIdsFrom(["b@other.com"], [])));
});

Deno.test("partiesMatch: a shared email clears the check even if a phone differs", () => {
  const a = partyIdsFrom(["shared@corp.com"], ["3475848008"]);
  const b = partyIdsFrom(["shared@corp.com"], ["972584146670"]);
  assert(partiesMatch(a, b));
  assertFalse(partiesConflict(a, b));
});

Deno.test("domainsRelated: a vendor's subdomain is the same authority", () => {
  // The DEP dunning case the matcher must keep merging.
  assert(domainsRelated("mail.dep.nyc.gov", "dep.nyc.gov"));
  assert(domainsRelated("dep.nyc.gov", "mail.dep.nyc.gov"));
  assert(domainsRelated("corp.com", "corp.com"));
  assertFalse(domainsRelated("a.com", "b.com"));
  // Near-miss: a suffix that is not a domain boundary must NOT match.
  assertFalse(domainsRelated("notdep.nyc.gov", "dep.nyc.gov"));
});

Deno.test("emailDomains: consumer domains carry no identity signal", () => {
  // Otherwise every pair of gmail senders would "share a party" and the veto
  // would silently disable itself.
  assertEquals([...emailDomains(new Set(["a@gmail.com"]))], []);
  assertEquals([...emailDomains(new Set(["a@corp.com"]))], ["corp.com"]);
});

Deno.test("msgPartyIds: a self-note has no counterparty", () => {
  for (const source_type of ["whatsapp_echo", "sms_echo"]) {
    const ids = msgPartyIds({ source_type, sender_email: "me@corp.com", metadata: { fromPhone: "123456789" } });
    assertEquals(ids.emails.size, 0);
    assertEquals(ids.phones.size, 0);
  }
});

Deno.test("msgPartyIds: outgoing mail's counterparty is the RECIPIENT", () => {
  const sent = msgPartyIds({ source_type: "gmail_sent", sender_email: "me@corp.com", metadata: { to: "them@other.com" } });
  assert(sent.emails.has("them@other.com"));
  assertFalse(sent.emails.has("me@corp.com"));
});

Deno.test("msgPartyIds: incoming mail ignores metadata.to (it is the user's own alias)", () => {
  // Folding it in would make every pair of emails share a party and disable
  // the check entirely.
  const inbound = msgPartyIds({ source_type: "gmail", sender_email: "them@other.com", metadata: { to: "me@corp.com" } });
  assert(inbound.emails.has("them@other.com"));
  assertFalse(inbound.emails.has("me@corp.com"));
});

Deno.test("msgPartyIds: a chat's counterparty comes from the chat metadata, never the body", () => {
  const chat = msgPartyIds({
    source_type: "whatsapp",
    sender: "Lea",
    metadata: { fromPhone: "+1-347-584-8008" },
    body_text: "call me on 972584146670 instead",
  });
  assert(chat.phones.has("75848008"));
  // The number quoted INSIDE the message is not the party — scraping it is
  // exactly how a "same phone" fantasy gets manufactured.
  assertFalse(chat.phones.has("84146670"));
});

Deno.test("taskTextNamesParty: the task naming the number rescues a real merge (T1086)", () => {
  const incoming = partyIdsFrom([], ["+1-347-584-8008"]);
  const task = { title_he: "לחזור לרב נגל", description: "הטלפון שלו 347-584-8008", title: null };
  assert(taskTextNamesParty(task, incoming));
  const unrelated = { title_he: "לשלם חשבון", description: "אין כאן מספר", title: null };
  assertFalse(taskTextNamesParty(unrelated, incoming));
});

Deno.test("taskTextNamesParty: a generic domain can never rescue a merge", () => {
  const incoming = partyIdsFrom(["someone@gmail.com"], []);
  const task = { title_he: "משהו", description: "כתבו לי מ-gmail.com", title: null };
  assertFalse(taskTextNamesParty(task, incoming));
});

Deno.test("taskPartyIds reads the contact fields; mergeParties unions them", () => {
  const task = taskPartyIds({
    related_contact_email: "them@other.com",
    related_contact_phone: "+1-347-584-8008",
    related_contact: null,
  });
  assert(task.emails.has("them@other.com"));
  assert(task.phones.has("75848008"));
  const merged = mergeParties(task, partyIdsFrom(["extra@corp.com"], []));
  assert(merged.emails.has("them@other.com") && merged.emails.has("extra@corp.com"));
});

Deno.test("extractEmails / extractPhones lowercase and de-duplicate", () => {
  assertEquals([...extractEmails("A@Corp.com and a@corp.com")], ["a@corp.com"]);
  // Too short to be a phone number — must not become an identity key.
  assertEquals([...extractPhones("12345")], []);
});

Deno.test("describeParty renders something readable for the audit trail", () => {
  assertEquals(describeParty(partyIdsFrom([], [])), "—");
  assert(describeParty(partyIdsFrom(["a@corp.com"], [])).includes("a@corp.com"));
});
