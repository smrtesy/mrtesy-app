# Info & Task Manager — CLAUDE.md
# קרא קובץ זה בתחילת כל session לפני כל פעולה אחרת

---

## אדריכלות המערכת

המערכת מחולקת ל-2 חלקים בלתי תלויים:

**PART 1 — COLLECTOR + TRIAGE** (איסוף + סינון ראשוני)
שולף מכל המקורות, מסנן ספאם/כללים, כותב ל-Processing Log.

**PART 2 — DEEP CLASSIFIER** (סיווג מעמיק)
קורא מ-Processing Log פריטים עם `Triage Status = pending_deep_classify`, מסווג עם AI, יוצר משימות.

**זהה את סוג הריצה מה-prompt** (PART 1 או PART 2). אל תבצע את שני החלקים באותה ריצה.

---

## NOTION DATABASES

| Database | URL | Collection ID |
|---|---|---|
| Tasks | https://www.notion.so/cfc0361aff49434bb591c7cfea22beba | c27f9c8e-c493-41eb-809a-edc70b79044e |
| Projects | https://www.notion.so/2914ed2ebe9f480bb59f06c0143677b2 | c29e51b4-1c43-4465-b5ce-e924762a3a0b |
| Contacts | https://www.notion.so/a52d6e1b342a460494df31848f12f20c | b6fb96bb-7bfb-4644-9b9c-d157c703163e |
| Rules & Memory | https://www.notion.so/dc610a5a65584f61af0f06bff93542a1 | e81b85f8-a3d4-48aa-bed9-524053a75859 |
| Processing Log | https://www.notion.so/ce8a4b94f07e4cb18d1f16166f76a791 | c786a5ed-032d-4d3b-a391-fb2185e037c9 |
| Run Sessions | https://www.notion.so/79b36cb189624ea8aa8e494c1fb03323 | 5134088d-b340-4506-ac5f-dbd5440be5f4 |

---

## SOURCES

| Source | Location |
|---|---|
| Gmail | חשבונות chanoch@maor.org + chanoch@kinus.info |
| WhatsApp | https://docs.google.com/spreadsheets/d/1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI — לשונית: Messages |
| Google Drive | Folder ID: `1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1` — חובה `'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents` בכל query |
| Google Calendar | לוח ראשי בלבד: chanoch770@gmail.com |

---

## GLOBAL RULES — חלות על שני ה-Parts

### 1. Run Sessions — תיעוד כל ריצה

בתחילת **כל ריצה** — צור דף ב-Run Sessions:
- Run Title: "PART1 Collector" / "PART2 Classifier" + תאריך ושעה
- Run Type: ONBOARDING / MORNING / INCREMENTAL
- Status: running
- Started At: עכשיו
- Model Used: Opus 4.7 / Sonnet / Haiku (לפי מה שידוע)

שמור Run Session page ID לזיכרון.

בסוף הריצה — עדכן:
- Status: completed / partial / failed
- Ended At: עכשיו
- Duration Minutes, כל ה-counts, Summary, Errors Log

### 2. כתיבה ל-Notion בחלקים קטנים

אל תיצור יותר מ-5 דפים בקריאה אחת. כתוב תוך כדי עיבוד, לא בסוף.

### 3. שגיאות MCP

אם כלי MCP מחזיר 502/timeout:
- המתן 5 שניות, נסה שוב עד 3 פעמים
- אם עדיין נכשל — רשום ב-Errors Log של Run Session, המשך למשאבים אחרים

### 4. אסור BULK PROCESSING

כל פריט = שורת לוג אישית משלו. אסור לקבץ "152 הודעות — בדיקות" לשורה אחת.
גם SKIPPED_SPAM — שורה אישית לכל פריט.

### 5. Drive — רק בתיקייה הספציפית

```
'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents and ...
```

אסור לחפש ב"שאר Drive". אם מקבלים תוצאות מחוץ לתיקייה — יש באג ב-query.

---

# PART 1 — COLLECTOR + TRIAGE

## מתי לרוץ: `prompt contains "PART1"`

## STEP 1.0 — STARTUP

1. צור Run Session חדש (ראה GLOBAL RULES #1)
2. טען את כל הכללים מ-Rules & Memory שבהם `Active = TRUE`
3. טען לזיכרון את כל `Source ID` הקיימים ב-Processing Log (מניעת כפילויות)

## STEP 1.1 — חלון זמן

| מקור | ONBOARDING (Tasks DB ריק) | ריצה רגילה |
|---|---|---|
| Gmail | 45 יום אחורה | שעה אחרונה |
| WhatsApp | 45 יום אחורה | שעה אחרונה |
| Drive | חודש אחורה | שעה אחרונה |
| Calendar | חודש קדימה | חודש קדימה (תמיד) |

## STEP 1.2 — איסוף

סדר איסוף חובה:
1. Gmail → 2. WhatsApp → 3. Drive → 4. Calendar

**חובה לעבור על כל 4** גם אם מקור מסוים החזיר הרבה תוצאות.

WhatsApp: גם incoming וגם outgoing. reaction → דלג ללא לוג.
Drive: רק בתיקייה (ראה Global Rule #5).

## STEP 1.3 — TRIAGE (סינון לכל פריט)

לכל פריט שנאסף — החלט אחד מארבעה:

### (א) SKIPPED_HARD_RULE — כלל קשה
תנאים שמפעילים:
- recipient = office@maor.org
- sender = outbox@maor.org
- Rules & Memory → rule_type=skip שמתאים לפריט

→ **לא נכנס ללוג כלל**. התעלם.

### (ב) SKIPPED_SPAM — ספאם/מרקטינג ברור
תנאים שמפעילים (לפחות אחד):
- sender מכיל noreply/no-reply
- subject או body מכיל unsubscribe link
- newsletter / marketing blast ברור
- promotion / sale / discount בלי קשר אישי

→ **כן נכנס ללוג** עם:
- Subject or Summary: כותרת המייל / סיכום קצר
- From, Source, Source Link, Date Received
- Triage Status: `skipped_spam`
- Classification: `SKIPPED_SPAM`
- Classification Reason: הסיבה לזיהוי
- **אל תשמור Raw Content** (חסכון)

### (ג) pending_deep_classify — ממתין לסיווג מעמיק
כל פריט שלא הוסר בשלב (א) או (ב).

→ **נכנס ללוג** עם:
- כל השדות למעלה
- Triage Status: `pending_deep_classify`
- Classification: `pending_classify`
- **Raw Content: שמור את התוכן המלא** (עד 3000 אותיות)
- Attachments Info: רשימה עם שמות קבצים אם יש

### (ד) Calendar reminders
אירועים מחר → Triage Status: `pending_deep_classify` עם Raw Content שכולל תיאור + משתתפים.

## STEP 1.4 — כתיבה ל-Processing Log

לכל פריט (חוץ מ-(א)) — צור דף ב-Processing Log עם השדות למעלה.

**חובה:** כתוב כל 5 פריטים, לא לצבור.

## STEP 1.5 — סיום Run Session

עדכן את ה-Run Session עם:
- Gmail Processed, WhatsApp Processed, Drive Processed, Calendar Processed
- Skipped Count (סך SKIPPED_SPAM + SKIPPED_HARD_RULE)
- Total Items (לא כולל skipped_hard_rule)
- Summary: "PART1 — נאסף X פריטים, נסונן Y ספאם, ממתינים לסיווג Z"
- Status: completed

---

# PART 2 — DEEP CLASSIFIER

## מתי לרוץ: `prompt contains "PART2"`

## STEP 2.0 — STARTUP

1. צור Run Session חדש
2. טען את כל הכללים מ-Rules & Memory (Active = TRUE)
3. טען את כל ה-Projects הקיימים לזיכרון (לזיהוי קשר)
4. טען את כל ה-Contacts הקיימים לזיכרון
5. קרא מ-Tasks את כל הדפים עם `Your Approval` ממולא — עבד לפי STEP 2.5

## STEP 2.1 — קריאת פריטים ממתינים

שלוף מ-Processing Log את כל הדפים עם `Triage Status = pending_deep_classify`.

אם אין כאלה → סיים את הריצה ב-Summary "אין פריטים חדשים לסיווג".

## STEP 2.2 — סיווג עם AI

לכל פריט — הפעל AI classifier:

```
SYSTEM: You are a message classifier.
Classify as ACTIONABLE / INFORMATIONAL.

ACTIONABLE: requires a real action or decision from the user
INFORMATIONAL: useful to know, no action needed

Rules:
- Failed payments, overdue notices, legal docs, requests → ACTIONABLE
- Payment confirmations, receipts, summaries → INFORMATIONAL
- maor.org domain emails → classify by content, category=maor
- Outgoing messages → focus on status change of open task

Respond with: CLASSIFICATION | reason in Hebrew | category (maor|personal)
```

USER message: כל השדות מ-Processing Log + Raw Content.

## STEP 2.3 — עיבוד לפי סיווג

### INFORMATIONAL
עדכן את דף ה-log:
- Classification: `INFORMATIONAL`
- Classification Reason: הסיבה מה-AI
- Triage Status: `classified`
- Action Taken: `logged_only`

אל תיצור משימה.

### ACTIONABLE
1. **זיהוי פרויקט** (אם יש הקשר):
   ```
   SYSTEM: Given these active projects: {list}, does this message belong?
   Respond with project ID or 'none'.
   ```

2. **חילוץ פרטי משימה:**
   ```
   SYSTEM: Extract task as JSON.
   {title_he, description, priority, due_date, tags, ai_actions}
   Priority:
     urgent: deadline today/tomorrow, legal, blocked account
     high: deadline within 7 days, payment failure
     medium: within 30 days
     low: no deadline
   ```

3. **מניעת כפילות:** חפש ב-Tasks לפי Source ID. אם קיים — עדכן במקום ליצור.

4. **צור/עדכן משימה ב-Tasks:**
   - Title, Status=pending_approval, Priority, Due Date
   - Source, Source ID, Source Link, Reply To Context
   - Description, Category, Tags, AI Actions
   - Update Log: "[DD/MM HH:MM] נוצרה מ-{source}"

5. **עדכן Contacts** אם שולח חדש.

6. **עדכן Projects** אם שייך לפרויקט — Key Dates, Description.

7. **עדכן את דף ה-log:**
   - Classification: `ACTIONABLE`
   - Triage Status: `classified`
   - Action Taken: `task_created`
   - Task ID: ה-ID של המשימה שנוצרה

## STEP 2.4 — בדיקת שלמות

לפני סיום, בדוק:
- כל דף ב-Processing Log עם `pending_deep_classify` עובד? אם לא — יש באג, רשום ב-Errors Log
- פריטים שנכשל ב-AI classifier — השאר `pending_classify`, נסה שוב בריצה הבאה

## STEP 2.5 — עיבוד אישורים מ-Tasks

| Your Approval | פעולה |
|---|---|
| approve | Status → inbox. נקה Your Approval. |
| reject | אם יש Your Feedback → הוסף כלל ב-Rules & Memory. Status → cancelled. |
| snooze | Status → snoozed. Due Date → מחר. |
| edit | השאר pending_approval. Update Log: "ממתין לעריכה". |

## STEP 2.6 — עיבוד פידבק מ-Processing Log

קרא דפים מ-Processing Log שבהם `Your Feedback` מלא ו-`Feedback Processed = FALSE`:
- המר כל פידבק לכלל חדש ב-Rules & Memory
- סמן Feedback Processed = TRUE

**מקרה מיוחד — פידבק "זה לא ספאם":**
אם פריט שהיה SKIPPED_SPAM מקבל פידבק "זה לא ספאם":
1. הוסף כלל ב-Rules & Memory: "sender X / pattern Y → classify" (לא SKIP)
2. שנה את ה-log: Triage Status → `pending_deep_classify`, Classification → `pending_classify`
3. הפריט יסווג בריצה הבאה

## STEP 2.7 — סיום Run Session

עדכן:
- Tasks Created, Tasks Updated
- Actionable Count, Informational Count
- Rules Added, Projects Created, Contacts Created
- Summary: "PART2 — סווגו X פריטים, נוצרו Y משימות"
- Status: completed
