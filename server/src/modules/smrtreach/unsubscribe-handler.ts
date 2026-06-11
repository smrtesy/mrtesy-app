/**
 * smrtReach — public unsubscribe endpoint (UNAUTHENTICATED).
 *
 * Mounted before the auth guards (like the smrtVoice webhook). The email's
 * List-Unsubscribe header points here (RFC 8058 one-click = POST), and the
 * footer link points here too (GET).
 *
 * Per Reach-4 / CRM-6, the preference lives in smrtCRM. Reach does NOT write
 * smrtCRM tables — it emits `contact.unsubscribed`, which smrtCRM's own
 * subscribe handler consumes to flip email_unsubscribed. This keeps the apps
 * decoupled.
 *
 * Identification uses contact_id + org_id from the link. A signed token is a
 * recommended follow-up to make the link unguessable.
 */

import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import { emitEvent } from "../../lib/platform";

const router = Router();

function page(message: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>הסרה מרשימת תפוצה</title>
<style>body{font-family:system-ui,Heebo,sans-serif;background:#FAFAF7;color:#23231F;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #E6E4DC;border-radius:.7rem;padding:2rem 2.5rem;max-width:28rem;
text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}</style></head>
<body><div class="card"><h1>${message}</h1></div></body></html>`;
}

async function handleUnsubscribe(req: Request, res: Response) {
  const contactId =
    (req.query.c as string | undefined) ?? (req.body?.c as string | undefined);
  const orgId =
    (req.query.o as string | undefined) ?? (req.body?.o as string | undefined);

  if (!contactId || !orgId) {
    return res.status(400).send(page("קישור הסרה לא תקין."));
  }

  // Emit the event; smrtCRM updates the contact. Failure here is logged inside
  // emitEvent — we still confirm to the user to avoid leaking processing state.
  await emitEvent(orgId, "smrtreach", "contact.unsubscribed", "contact", contactId, {});

  // RFC 8058 one-click POST expects a 200 with no required body.
  if (req.method === "POST") return res.status(200).json({ ok: true });
  res.status(200).send(page("הוסרת מרשימת התפוצה. לא תקבל/י עוד מיילים."));
}

router.get("/reach/unsubscribe", handleUnsubscribe);
router.post("/reach/unsubscribe", handleUnsubscribe);

// ── Granular preferences (botsite parity: all/weekly/monthly/none) ──────────
const FREQ_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "הכל — כל המיילים" },
  { value: "weekly", label: "שבועי — עד מייל אחד בשבוע" },
  { value: "monthly", label: "חודשי — רק העדכונים החשובים" },
  { value: "none", label: "להפסיק לקבל מיילים" },
];

function preferencesPage(contactId: string, orgId: string): string {
  const radios = FREQ_OPTIONS.map(
    (o) =>
      `<label style="display:block;text-align:right;margin:.5rem 0;cursor:pointer">` +
      `<input type="radio" name="frequency" value="${o.value}"> ${o.label}</label>`,
  ).join("");
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ניהול העדפות דיוור</title>
<style>body{font-family:system-ui,Heebo,sans-serif;background:#FAFAF7;color:#23231F;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #E6E4DC;border-radius:.7rem;padding:2rem 2.5rem;max-width:28rem;
box-shadow:0 1px 3px rgba(0,0,0,.06)}
button{margin-top:1rem;width:100%;padding:.6rem;border:0;border-radius:.5rem;background:#23231F;color:#fff;
font-size:1rem;cursor:pointer}</style></head>
<body><div class="card"><h1 style="text-align:center">ניהול העדפות דיוור</h1>
<form method="POST" action="/api/reach/preferences">
<input type="hidden" name="c" value="${contactId}"><input type="hidden" name="o" value="${orgId}">
${radios}<button type="submit">שמירה</button></form></div></body></html>`;
}

router.get("/reach/preferences", (req: Request, res: Response) => {
  const contactId = req.query.c as string | undefined;
  const orgId = req.query.o as string | undefined;
  if (!contactId || !orgId) return res.status(400).send(page("קישור לא תקין."));
  res.status(200).send(preferencesPage(contactId, orgId));
});

// The preferences form posts application/x-www-form-urlencoded; the global
// parser is express.json() only, so parse the form body locally here.
router.post("/reach/preferences", urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const contactId = (req.body?.c as string | undefined) ?? (req.query.c as string | undefined);
  const orgId = (req.body?.o as string | undefined) ?? (req.query.o as string | undefined);
  const frequency = String(req.body?.frequency ?? "");
  const valid = ["all", "weekly", "monthly", "none"];
  if (!contactId || !orgId || !valid.includes(frequency)) {
    return res.status(400).send(page("בחירה לא תקינה."));
  }
  // smrtCRM owns the preference — emit the event its handler consumes.
  await emitEvent(orgId, "smrtreach", "contact.preference_changed", "contact", contactId, { frequency });
  res.status(200).send(page("ההעדפה נשמרה. תודה!"));
});

export default router;
