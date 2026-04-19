# Info & Task Manager — CLAUDE.md
# קרא קובץ זה בתחילת כל session לפני כל פעולה אחרת

## NOTION DATABASES

| Database | URL | Collection ID |
|---|---|---|
| Tasks | https://www.notion.so/e18b0946aaa84424a5b7e9d427c7e354 | 6c865ef1-a3b6-4801-a618-ecc7c7632c0f |
| Projects | https://www.notion.so/6f9fad8245c049909cea499128ef6244 | 020c0d5e-b29c-4c42-a63c-e44f47880c08 |
| Contacts | https://www.notion.so/1acf390f98d0429cb91597ba135ef9a5 | 30c798d8-a5bc-41ac-9b10-7dab8c9acf21 |
| Rules & Memory | https://www.notion.so/8016d1d19acf41e5942bbd6fe6261663 | 32c83672-e661-4cf4-9710-e24e59d9bf62 |
| Processing Log | https://www.notion.so/19d2f60f900d4a37861cf5a3c8b15a72 | 4270177a-0324-4a2d-93d4-700b09b40b15 |
| Run Sessions | https://www.notion.so/3dcd7ce16fdc4832adbe9e0e707d00eb | 8749e44b-4711-40a2-a736-173b8823da93 |

## CRITICAL — כתיבה ל-Notion בחלקים קטנים

אל תיצור יותר מ-5 דפים בקריאת Notion אחת.
אחרי כל 5 דפים — המשך לבאחים הבאים.
אל תצבור את כל המשימות ותכתוב הכל בסוף — כתוב תוך כדי עיבוד.

סדר עבודה נכון:
1. עבד 5 הודעות → כתוב 5 דפים → המשך ל-5 הבאות
2. אל תחכה לסוף הריצה כדי לכתוב

## CRITICAL — התמודדות עם שגיאות MCP

אם Gmail מחזיר 502 או timeout:
- המתן 5 שניות ונסה שוב עד 3 פעמים
- אם עדיין נכשל — עבור ל-WhatsApp ו-Drive, חזור ל-Gmail בסוף
- רשום ב-Processing Log: "Gmail temporarily unavailable, retried X times"

## CRITICAL — עבד את כל המקורות

חובה לעבד את כל ארבעת המקורות בכל ריצה. אל תסיים לפני שעברת על כולם:
1. Gmail — תמיד ראשון
2. WhatsApp — תמיד שני, גם אם Gmail החזיר הרבה תוצאות
3. Google Drive — תמיד שלישי
4. Google Calendar — תמיד רביעי

אל תעצור אחרי מקור אחד. כמות התוצאות מ-Gmail לא משפיעה על החובה לעבד את שאר המקורות.

## CRITICAL — אסור BULK PROCESSING בשום אופן

**אסור בתכלית האיסור** לקבץ כמה הודעות/קבצים לשורת לוג אחת שמסכמת את כולם.

דוגמאות לדברים **אסורים** שנעשו בעבר:
- ❌ שורת לוג אחת: "152 הודעות WhatsApp — בדיקות של הבוט"
- ❌ שורת לוג אחת: "20 קבצי Drive — node_modules"
- ❌ שורת לוג אחת: "אין קבצים חדשים בתיקייה"

**הכלל:** כל הודעה, כל קובץ, כל אירוע — שורת לוג נפרדת משלו.

אם יש 152 הודעות WhatsApp → יהיו 152 שורות לוג.
אם יש 30 קבצים ב-Drive → יהיו 30 שורות לוג.
בלי יוצאים מן הכלל.

גם אם הודעה נראית כמו "בדיקה" או "לא רלוונטית" — שורת לוג נפרדת עם classification=SKIP או INFORMATIONAL וסיבה ספציפית להודעה **הזו**.

## CRITICAL — אם פריט לא בלוג, סרוק אותו שוב

לפני סיום הריצה, חובה לבצע בדיקת שלמות:

1. קרא את כל Source ID הקיימים ב-Processing Log (מכל הריצות הקודמות) לזיכרון
2. לכל פריט שמצאת מהמקורות (Gmail / WhatsApp / Drive / Calendar):
   - בדוק אם ה-Source ID שלו קיים ברשימה מ-Processing Log
   - אם **לא קיים** → זו הוכחה שאף פעם לא עובד (ריצה נכשלה / bulk skip / bug)
   - **חובה לעבד אותו עכשיו**, גם אם הוא מחוץ לחלון הזמן הרגיל
   - צור שורת לוג אישית + משימה אם actionable

זה מתקן ריצות שנכשלו באמצע ומונע מפריטים "ליפול בין הכיסאות".

## CRITICAL — Drive: רק בתיקייה הספציפית

בכל search query ל-Drive — **חובה** להכליל את הפילטר:
```
'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents
```

**אסור** לחפש ב-"שאר ה-Drive". אל תזכיר node_modules, repos, או כל קובץ שלא בתיקייה הזו בלוג.

אם Drive search מחזיר קבצים שלא בתיקייה הזו — זה באג בקוד שלך. תקן את ה-query והרץ שוב.

## CRITICAL — Run Sessions: תיעוד מלא של כל ריצה

בתחילת **כל ריצה** — צור דף חדש ב-Run Sessions עם:
- Run Title: "ריצה {RUN_TYPE} — {תאריך} {שעה}"
- Run Type: ONBOARDING / MORNING / INCREMENTAL
- Status: running
- Started At: עכשיו
- Model Used: השם של המודל שבשימוש (Opus 4.7, Sonnet 4.6 וכו' — אם ידוע)

שמור את ה-Run Session ID לזיכרון.

במהלך הריצה — ספור תוך כדי:
- כמה פריטים עובדו מכל מקור
- כמה משימות נוצרו / עודכנו
- כמה כללים נוספו, פרויקטים, אנשי קשר
- שגיאות (לוג מפורט)

בסוף הריצה — עדכן את ה-Run Session הזה עם:
- Status: completed / partial / failed
- Ended At: עכשיו
- Duration Minutes: חישוב
- כל ה-counts
- Summary: סיכום מילולי של הריצה — מה נעשה, מה לא, המלצות
- Errors Log: אם היו שגיאות

**אם הריצה נכשלת באמצע** — עדכן Status=failed עם פירוט השגיאה ב-Errors Log לפני שאתה עוצר.

**Tokens Estimate:** הערכה מקורבת — גודל כולל של טקסט שנקרא + נכתב בתווים / 4 (בערך).

---



| Source | Location |
|---|---|
| Gmail | חשבונות chanoch@maor.org + chanoch@kinus.info |
| WhatsApp | https://docs.google.com/spreadsheets/d/1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI — לשונית: Messages |
| Google Drive | Folder ID: `1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1` — חובה לחפש עם: `'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents` בכל search query |
| Google Calendar | לוח ראשי בלבד: chanoch770@gmail.com |

---

## STEP 0 — STARTUP (כל ריצה מתחילה כאן)

### 0.1 זהה סוג ריצה
```
אם Tasks database ריק → RUN_TYPE = ONBOARDING
אחרת קרא מה-prompt: MORNING_RUN או INCREMENTAL_RUN
```

### 0.2 טען Rules & Memory
קרא את כל הדפים מ-Rules & Memory שבהם Active = TRUE.
טען לזיכרון — תשתמש בהם בשלב הסיווג לפני כל קריאה ל-AI.

### 0.3 קרא אישורים ממתינים
קרא דפים מ-Tasks שבהם "Your Approval" מלא (approve / reject / snooze / edit).
טפל בהם לפי STEP 5 לפני שמתחיל לעבד הודעות חדשות.

### 0.4 קרא פידבק ממתין מ-Processing Log (ריצת בוקר בלבד)
קרא דפים מ-Processing Log שבהם "Your Feedback" מלא ו-"Feedback Processed" = FALSE.
המר כל פידבק לכלל חדש ב-Rules & Memory, סמן Feedback Processed = TRUE.

---

## STEP 1 — חלון זמן לפי סוג ריצה

| מקור | ONBOARDING | MORNING_RUN | INCREMENTAL_RUN |
|---|---|---|---|
| Gmail | 45 יום אחורה | 24 שעות אחורה | 10 דקות אחורה |
| WhatsApp | 45 יום אחורה | 24 שעות אחורה | 10 דקות אחורה |
| Google Drive | חודש אחרון | 24 שעות אחורה | 10 דקות אחורה |
| Google Calendar | חודש קדימה | חודש קדימה (תמיד) | חודש קדימה (תמיד) |

### קריאת Google Drive
חובה להשתמש בפילטר תיקייה בכל search query:
```
'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents and modifiedTime > '{timestamp}' and mimeType != 'application/vnd.google-apps.folder'
```
אל תחפש בכל Drive — רק בתיקייה הספציפית הזו.


עמודות רלוונטיות: Timestamp, Direction, Message ID, From Phone, From Name,
Chat Type, Group Name, Message Type, Text Content, Reply To.

**חשוב:**
- עבד גם incoming וגם outgoing
- כאשר Reply To מלא — חפש את ההודעה המקורית לפי Message ID וקרא את שניהם יחד
- Message Type = reaction → SKIP ללא לוג

### הודעות יוצאות (Direction = outgoing)
אל תדלג. הן מעדכנות סטטוס משימות קיימות:
- שלחת תשובה → Tasks: inbox → in_progress
- שלחת תשובה סופית → Tasks: → done  
- שלחת שאלה שמחכה לתגובה → Tasks: → waiting

---

## STEP 2 — סיווג

### כללים קשיחים (לפני AI)

| תנאי | פעולה |
|---|---|
| recipient = office@maor.org | SKIP — ללא לוג |
| sender = outbox@maor.org | SKIP — ללא לוג |
| WhatsApp message_type = reaction | SKIP — ללא לוג |
| אירוע Calendar שתאריכו עבר | SKIP |

### כללים דינמיים
בדוק כל פריט מול הכללים שטענת ב-STEP 0.2. אם כלל מתאים — פעל לפיו ללא AI.

### סיווג AI — system prompt
```
You are a message classifier for a personal task management system.
Classify each message as exactly one of:
  ACTIONABLE — requires a real action or decision from the user
  INFORMATIONAL — useful to know, no action needed
  SKIP — irrelevant, spam, pure automation noise

Rules:
- Failed payments, overdue notices, legal docs, requests → ACTIONABLE
- Payment confirmations (successful), receipts, summaries → INFORMATIONAL
- maor.org domain emails → classify by content, never SKIP, assign category=maor
- Outgoing messages → classify by content, focus on status change of open task
- Newsletter / marketing / unsubscribe patterns → INFORMATIONAL (not SKIP)

Respond with exactly: CLASSIFICATION | reason in Hebrew (1 sentence)
```

### סיווג AI — user message template
```
Source: {gmail | whatsapp | drive | calendar}
Direction: {incoming | outgoing}
From: {sender}
To: {recipient}
Date: {date}
Subject: {subject if gmail}
Chat: {group name or 'private' if whatsapp}
Reply to context: {quoted message or 'none'}

Content:
{full text — max 3,000 chars}
```

---

## STEP 3 — טיפול לפי סיווג

### SKIP
אל תיצור שום רשומה. המשך לפריט הבא.

### INFORMATIONAL
כתוב שורה ל-Processing Log בלבד (ראה STEP 4.1). אל תיצור משימה.

### ACTIONABLE — זיהוי פרויקט
```
SYSTEM: You have these active projects:
{project_id}: {name} — {description_short}
...
Does this message belong to one of them?
Respond with ONLY the project page URL or 'none'.
```

קטגוריה: שולח/פרויקט קשור ל-maor.org → category=maor. כל השאר → category=personal.

### ACTIONABLE — יצירת משימה
```
SYSTEM:
You are a task extraction AI. Return a valid JSON array only. No markdown.

For each actionable item:
{
  "title_he": "כותרת קצרה בעברית — עד 80 תווים",
  "description": "כל הפרטים: מספרי חשבון, סכומים, דדליינים, שמות, הוראות, קישורים. הכל.",
  "priority": "urgent | high | medium | low",
  "due_date": "YYYY-MM-DD or null",
  "is_overdue": true | false,
  "tags": ["tag1", "tag2"],
  "ai_actions": ["פעולה מוצעת 1", "פעולה מוצעת 2"],
  "contact_name": "string or null",
  "contact_email": "string or null"
}

Priority rules:
  urgent: deadline today/tomorrow, legal threat, blocked account, foreclosure risk
  high: deadline within 7 days, payment failure
  medium: deadline within 30 days
  low: no deadline, soft follow-up

One message may produce multiple tasks.
If project context provided — use it to enrich the description.
Respond with ONLY the JSON array.
```

```
USER:
From: {sender}  To: {recipient}  Date: {date}
Source: {source}  Source Link: {direct_link}
Reply to context: {context or 'none'}
Project: {project_name if found}
Project context: {description, key_dates if found}

{full content — max 4,000 chars}
```

---

## STEP 4 — כתיבה ל-Notion

### 4.1 Processing Log — כל פריט שעובד (גם INFORMATIONAL)

כתוב דף חדש ל-Processing Log עם:
```
Subject or Summary: נושא המייל או סיכום קצר
Classification: ACTIONABLE / INFORMATIONAL / SKIP
Classification Reason: סיבה בעברית
Source: gmail / whatsapp / drive / calendar
Direction: incoming / outgoing
From: שולח
date:Date Received:start: YYYY-MM-DD
Source Link: קישור ישיר למקור
Reply To Context: הקשר thread אם קיים
Action Taken: task_created / status_updated / logged_only / skipped
Task ID: אם נוצרה משימה
Your Feedback: (ריק — אתה כותב)
Feedback Processed: __NO__
```

### 4.2 Tasks — מניעת כפילויות
לפני כתיבה — חפש ב-Tasks לפי Source ID. אם קיים — עדכן דף קיים, אל תיצור חדש.

כתוב דף חדש ל-Tasks עם:
```
Title: כותרת
Status: pending_approval
Priority: urgent / high / medium / low
date:Due Date:start: YYYY-MM-DD (אם קיים)
Source: gmail / whatsapp / drive / calendar
Source ID: Message ID / file ID
Source Link: קישור ישיר
Reply To Context: הקשר thread
Description: כל הפרטים המלאים
Tags: [רשימה]
Category: maor / personal
AI Actions: פעולות מוצעות
Update Log: [DD/MM HH:MM] נוצרה מ-{source}
```

### 4.3 Contacts — אוטומטי
לכל שולח חדש שלא קיים ב-Contacts — צור דף חדש. בדוק לפי Email לפני יצירה.

---

## STEP 5 — עיבוד אישורים (STEP 0.3)

| Your Approval | פעולה |
|---|---|
| approve | Status → inbox. נקה Your Approval. כתוב ב-Update Log. |
| reject | אם יש Your Feedback → הוסף כלל ל-Rules & Memory. Status → cancelled. |
| snooze | Status → snoozed. Due Date → מחר. נקה Your Approval. |
| edit | השאר pending_approval. כתוב ב-Update Log: "ממתין לעריכה ידנית". |

---

## STEP 6 — Calendar

| מצב | פעולה |
|---|---|
| אירוע מחר — זוהה לראשונה | צור Tasks עם Status=calendar_reminder, Priority=medium |
| Your Approval = saw | Status → snoozed, Due Date → יום האירוע. יחזור ביום האירוע. |
| Your Approval = approve | Status → inbox — הפך למשימה רגילה |
| יום האירוע עצמו | אם Status=snoozed → החזר ל-pending_approval |
| אירוע 2-30 יום קדימה | עדכן Projects בלבד, אל תיצור משימה |

---

## STEP 7 — Projects & Contacts

**Projects:**
- 2+ הודעות לנושא ללא פרויקט קיים → הצע פרויקט חדש עם Status=proposed
- עדכן Key Dates ו-Description כשמגיע מידע חדש
- ONBOARDING בלבד: לאחר כל העיבוד, הצע פרויקטים על בסיס קבוצות נושאים

**Contacts:**
- צור contact חדש לכל שולח שלא קיים
- בדוק לפי Email לפני יצירה — אל תשכפל
- צבור Account Numbers שמופיעים בהודעות

---

## STEP 8 — Rules & Memory

כתוב כלל חדש כאשר:
- המשתמש כתב Your Feedback על reject
- המשתמש כתב Your Feedback ב-Processing Log

מבנה כלל חדש:
```
Trigger: sender= / subject_contains= / domain= / direction=outgoing+keyword=
Rule Type: skip / classify / assign_project / assign_contact / tag / priority
Action: מה לעשות
Reason: הסבר קצר
Active: TRUE
Created By: claude
```

---

## GUARDRAILS

| מצב | טיפול |
|---|---|
| Source ID כבר קיים ב-Tasks | עדכן דף קיים — אל תיצור כפילות |
| AI מחזיר JSON שבור | צור משימה עם טקסט גולמי כ-Description, subject ככותרת |
| Drive document | קרא metadata + 200 תווים ראשונים בלבד |
| יותר מ-100 פריטים בריצה | עבד לפי עדיפות: Calendar → WhatsApp → Gmail דחוף → Gmail רגיל → Drive |
| ONBOARDING — כמות הצעות | אין הגבלה. צור הצעה לכל פריט ACTIONABLE שמוצאים. המשתמש מסנן דרך your_approval. |
| Reply To קיים אך לא נמצא | המשך עם מה שיש, ציין "context not found" ב-Reply To Context |

---

## סדר פעולות — סיכום

```
STEP 0 → טען Rules, קרא אישורים, זהה סוג ריצה
STEP 1 → אסוף פריטים לפי חלון זמן
STEP 2 → סווג כל פריט
STEP 3 → INFORMATIONAL=לוג בלבד | ACTIONABLE=פרויקט+משימה
STEP 4 → כתוב ל-Processing Log + Tasks
STEP 5 → עבד אישורים ממתינים
STEP 6 → טפל ב-Calendar
STEP 7 → עדכן Projects ו-Contacts
STEP 8 → כתוב כללים חדשים מפידבק
```
