/**
 * Meta Cloud API error decoder (shared).
 *
 * Used by every module that talks to the WhatsApp Cloud API — smrtBot's send
 * stack (wa.ts) and smrtTask's WhatsApp inbox view (whatsapp-view.ts).
 *
 * Meta returns failures as an HTTP status + a JSON body whose *actionable* code
 * lives in `error.code` (occasionally in `error.error_subcode`). Left raw, an
 * operator only sees "Meta API 401 — {...\"code\":190...}" and has to look the
 * number up. This maps the codes we actually hit to a clear Hebrew sentence
 * that says what broke and — where possible — how to fix it, so every
 * reportError / notify that surfaces a send failure is self-explanatory.
 *
 * Resolution order for the summary:
 *   1. A known code (with optional subcode refinement) → our curated message.
 *   2. Meta's own human-readable `error_user_title`/`error_user_msg` when present
 *      (Meta ships these for many user-facing failures).
 *   3. Meta's raw `error.message`, prefixed with the code.
 *   4. An unparseable body → the bare HTTP status.
 *
 * Ref: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */

export interface MetaErrorInfo {
  code: number | null;
  subcode: number | null;
  /** Clear, actionable Hebrew explanation of the failure. */
  summary: string;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
  };
}

/** code → clear Hebrew explanation (+ fix guidance where the operator can act).
 *  Covers the WhatsApp Cloud API codes this system actually encounters. */
const CODE_MESSAGES: Record<number, string> = {
  // ── Authentication / authorization ─────────────────────────────
  0: "שגיאה כללית מול Meta. בדוק שהטוקן והמזהים הוגדרו נכון בהגדרות ה‑WhatsApp של הבוט, ונסה שוב.",
  190: "אימות מול Meta נכשל: הטוקן (access token) אינו תקף או שפג תוקפו. החלף אותו בטוקן System User קבוע בהגדרות ה‑WhatsApp של הבוט (טוקן זמני של 24 שעות פג ומפסיק לעבוד).",
  102: "פג תוקף ההרשאה מול Meta (session). יש ליצור טוקן חדש ולעדכן אותו בהגדרות הבוט.",
  10: "הרשאה חסרה: לטוקן אין הרשאת whatsapp_business_messaging, או שחשבון ה‑WhatsApp (WABA) אינו משויך ל‑System User שהנפיק את הטוקן.",
  3: "לטוקן/לאפליקציה אין הרשאה לפעולה הזו מול Meta. ודא שההרשאות whatsapp_business_messaging ו‑whatsapp_business_management מאושרות.",

  // ── Request / parameters ───────────────────────────────────────
  100: "פרמטר או מזהה לא תקין בבקשה ל‑Meta — לרוב phone_number_id שגוי, או הרשאה/נכס שאינם משויכים לטוקן.",
  131008: "בבקשה ל‑Meta חסר שדה חובה.",
  131009: "ערך של אחד השדות בבקשה ל‑Meta אינו תקין.",
  131000: "Meta החזירה שגיאה כללית בעת השליחה. נסה שוב; אם זה חוזר, בדוק את הגדרות הבוט.",

  // ── Delivery / recipient ───────────────────────────────────────
  131030: "מספר הנמען אינו ברשימת הנמענים המאושרים. בסביבת test של Meta אפשר לשלוח רק למספרים שהוספת ידנית ברשימת ה‑recipients. הוסף את המספר, או עבור ל‑WABA אמיתי (live).",
  131026: "ההודעה אינה ניתנת למסירה: המספר אינו משתמש WhatsApp פעיל, או שהנמען חסם את המספר העסקי.",
  131047: "חלון 24 השעות נסגר: אי אפשר לשלוח טקסט חופשי לנמען שלא כתב ב‑24 השעות האחרונות — יש להשתמש בתבנית (template) מאושרת.",
  131051: "סוג ההודעה שנשלח אינו נתמך.",
  131049: "Meta בחרה לא למסור את ההודעה כדי לשמור על איכות חוויית המשתמש (מגבלת הודעות שיווקיות לנמען).",
  131050: "הנמען ביקש להפסיק לקבל הודעות שיווקיות מהעסק.",

  // ── Rate limits (transient) ────────────────────────────────────
  131056: "נשלחו יותר מדי הודעות לאותו נמען בזמן קצר (מגבלת קצב לזוג שולח‑נמען). נסה שוב מאוחר יותר.",
  80007: "חריגה ממגבלת קצב השליחה של Meta. האט את קצב השליחה ונסה שוב מאוחר יותר.",
  130429: "חריגה ממגבלת קצב השליחה של Cloud API. נסה שוב מאוחר יותר.",
  131048: "Meta חסמה זמנית את השליחה בשל חשד לספאם. האט את קצב השליחה.",
  4: "האפליקציה הגיעה למגבלת הבקשות של Meta. נסה שוב מאוחר יותר.",
  613: "חריגה ממגבלת קצב הקריאות ל‑API של Meta. נסה שוב מאוחר יותר.",

  // ── Templates ──────────────────────────────────────────────────
  132000: "אי‑התאמה במספר הפרמטרים של התבנית (template) — מספר ה‑{{n}} בתבנית שונה ממספר הערכים שנשלחו.",
  132001: "התבנית (template) לא קיימת בשם/בשפה שנשלחו, או שאינה מאושרת.",
  132005: "הטקסט של התבנית לאחר מילוי הפרמטרים ארוך מדי.",
  132007: "תוכן התבנית מפר את מדיניות Meta.",
  132012: "פורמט אחד מפרמטרי התבנית אינו תואם למוגדר בתבנית.",
  132015: "התבנית מושהית (paused) ב‑Meta ולכן אי אפשר לשלוח אותה.",
  132016: "התבנית מושבתת (disabled) ב‑Meta.",

  // ── Account / registration ─────────────────────────────────────
  133010: "מספר הטלפון אינו רשום ב‑Cloud API. יש להשלים את רישום המספר ב‑Meta.",
  133016: "המספר/החשבון מוגבל וזקוק לרישום מחדש ב‑Meta.",
  131037: "חשבון ה‑WhatsApp Business (WABA) אינו רשום או אינו מאומת במלואו ב‑Meta.",
  368: "המספר נחסם זמנית על ידי Meta בשל הפרות מדיניות.",

  // ── Server-side (transient) ────────────────────────────────────
  1: "שגיאה כללית או זמנית מול Meta. נסה שוב מאוחר יותר; אם זה חוזר, בדוק את הגדרות הבוט.",
  2: "שירות Meta אינו זמין זמנית. נסה שוב מאוחר יותר.",
  133004: "שרתי Meta אינם זמינים זמנית. נסה שוב מאוחר יותר.",
};

/** Subcode refinements for codes whose meaning splits on the subcode. */
function refineBySubcode(code: number, subcode: number): string | null {
  if (code === 100 && subcode === 33) {
    return "המזהה שנשלח ל‑Meta (phone_number_id) אינו קיים או שאין לטוקן הרשאה אליו. ודא שה‑phone_number_id נכון וש‑WABA משויך לטוקן.";
  }
  if (code === 190 && (subcode === 463 || subcode === 467)) {
    return "הטוקן (access token) פג תוקף. החלף אותו בטוקן System User קבוע בהגדרות ה‑WhatsApp של הבוט.";
  }
  return null;
}

/** Parse Meta's error body (a JSON string or already-parsed object) into a
 *  clear, actionable summary plus the code/subcode for downstream logic. */
export function describeMetaError(status: number, detail: unknown): MetaErrorInfo {
  let body: MetaErrorBody | null = null;
  if (typeof detail === "string" && detail.trim()) {
    try {
      body = JSON.parse(detail) as MetaErrorBody;
    } catch {
      body = null;
    }
  } else if (detail && typeof detail === "object") {
    body = detail as MetaErrorBody;
  }

  const err = body?.error;
  const code = err?.code ?? null;
  const subcode = err?.error_subcode ?? null;

  if (code != null) {
    const refined = subcode != null ? refineBySubcode(code, subcode) : null;
    if (refined) return { code, subcode, summary: refined };

    const known = CODE_MESSAGES[code];
    if (known) return { code, subcode, summary: known };

    // Meta ships operator-friendly text for many failures — prefer it over the
    // terse `message` when present.
    if (err?.error_user_msg) {
      const title = err.error_user_title ? `${err.error_user_title}: ` : "";
      return { code, subcode, summary: `Meta (קוד ${code}) — ${title}${err.error_user_msg}` };
    }
    if (err?.message) {
      return { code, subcode, summary: `Meta (קוד ${code}) — ${err.message}` };
    }
    return { code, subcode, summary: `שגיאת Meta (קוד ${code}).` };
  }

  // No parseable code — fall back to the HTTP status with a hint for the classics.
  if (status === 401 || status === 403) {
    return { code: null, subcode: null, summary: `אימות מול Meta נכשל (HTTP ${status}). בדוק את הטוקן וההרשאות בהגדרות הבוט.` };
  }
  if (status === 429) {
    return { code: null, subcode: null, summary: "חריגה ממגבלת קצב השליחה של Meta (HTTP 429). נסה שוב מאוחר יותר." };
  }
  if (status >= 500) {
    return { code: null, subcode: null, summary: `שירות Meta אינו זמין זמנית (HTTP ${status}). נסה שוב מאוחר יותר.` };
  }
  return { code: null, subcode: null, summary: `שגיאה מול Meta (HTTP ${status}).` };
}

/** Convenience: just the clear Hebrew summary string. */
export function metaErrorSummary(status: number, detail: unknown): string {
  return describeMetaError(status, detail).summary;
}
