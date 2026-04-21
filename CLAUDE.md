# Info & Task Manager — CLAUDE.md v4
# קרא קובץ זה בתחילת כל session לפני כל פעולה אחרת

---

## ארכיטקטורה

המערכת מחולקת ל-**4 חלקים** בלתי תלויים:

| Part | תפקיד | תדירות |
|---|---|---|
| **PART 1** — Email + Drive Collector | איסוף מ-Gmail/Drive + טריאז' | 3x ביום |
| **PART 2** — WhatsApp Conversation Analyzer | ניתוח שיחות שלמות | 3x ביום |
| **PART 3** — Deep Classifier | סיווג מעמיק + יצירת משימות | 3x ביום |
| **PART 4** — Action Executor | ביצוע פעולות שהמשתמש ביקש | כל 30 דק' |

**זהה את ה-Part מה-prompt ובצע רק אותו. אל תבצע יותר מ-Part אחד בריצה.**

---

## NOTION DATABASES

| Database | URL | Collection ID |
|---|---|---|
| Tasks | https://www.notion.so/302a9ffb9d034b548f6c57c5f7cf60c8 | 3d956725-ac6b-4ddf-ba1d-11ed549e4d3e |
| Projects | https://www.notion.so/d7d5e4d08ef547ec9c050fd97f0bbeb8 | a2b5784f-ae5e-44d4-a813-0483cd5393ed |
| Contacts | https://www.notion.so/7dc1dc18ff384e7891337373135adb2c | c76a052e-0dc0-4917-bd6a-dcc1ff4cbcce |
| Rules & Memory | https://www.notion.so/dc610a5a65584f61af0f06bff93542a1 | e81b85f8-a3d4-48aa-bed9-524053a75859 |
| Processing Log | https://www.notion.so/270d5f6d0549453da57ec0456750ca09 | d47bac97-2e3f-44d5-9b4b-d93405035c7a |
| Run Sessions | https://www.notion.so/d75ba7caa0a349ed9c5dc49488cbeea2 | 7525ff81-ccb8-4fe6-bbef-9f8afad15190 |
| Action History | https://www.notion.so/a32511ad0f254853a343632fc5fa9121 | d9ad2735-af9f-4233-9eba-f6f2b1936da0 |

---

## SOURCES

| Source | Location |
|---|---|
| Gmail | `chanoch@maor.org` + `chanoch@kinus.info` |
| WhatsApp | Google Sheets: `1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI` לשונית Messages |
| Google Drive | Folder ID: `1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1` (ScanSnap) |
| Google Calendar | chanoch770@gmail.com |

---

## USER INFO

- **שם:** חנוך חסקינד (Chanoch Chaskind)
- **חווה (המזכירה):** WhatsApp +17326660770

---

## GLOBAL RULES

### 1. Run Sessions — תיעוד כל ריצה

בתחילת **כל ריצה**, צור דף ב-Run Sessions:
- Run Title: "PARTx [Name] — YYYY-MM-DD HH:MM"
- Run Type: ONBOARDING / COLLECTOR / CLASSIFIER
- Status: running
- Started At: עכשיו
- Model Used: Opus 4.7 / Sonnet / Haiku

בסוף הריצה עדכן: Status, Ended At, Duration, Counts, Summary, Errors Log.

### 2. כתיבה ל-Notion בחלקים קטנים

אל תיצור יותר מ-5 דפים בקריאה אחת. כתוב תוך כדי עיבוד.

### 3. שגיאות MCP

502/timeout → המתן 5 שניות, נסה שוב עד 3 פעמים. אם עדיין נכשל — רשום ב-Errors Log.

### 4. אסור BULK PROCESSING

כל פריט = שורת לוג אישית. אסור "152 הודעות — בדיקות" לשורה אחת.

### 5. Drive — רק בתיקייה הספציפית

```
parentId = '1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' and modifiedTime >= '2026-03-20T00:00:00Z'
```

- MCP משתמש ב-`parentId =` (לא `in parents`)
- חובה `Z` בסוף התאריך (ISO 8601 UTC)
- חובה `pageSize: 10`, `excludeContentSnippets: true`

### 6. WhatsApp — קובץ גדול

**חובה** `download_file_content` עם `exportMimeType='text/csv'` (לא `read_file_content` — הקובץ ענק, 300K+ תווים).

### 7. 🚨 EFFICIENCY RULES — חובה

הריצה הקודמת כשלה כי בוצעו קריאות מיותרות לפני שהתחילה עבודה אמיתית. חובה להימנע מזה:

**אל תעשה את הדברים הבאים:**

1. **אל תטען schemas** — כל ה-database IDs וה-collection IDs כבר נמצאים ב-CLAUDE.md למעלה. אין צורך ב-`notion-fetch` על schema.
2. **אל תחפש אותו דבר כמה פעמים** — אם חיפוש אחד לא הניב תוצאות, נסה ניסוח אחד נוסף בלבד. אחרי זה עצור.
3. **אל תטען Rules & Memory פעמיים** — טען פעם אחת בתחילת הריצה, שמור במשתנה, השתמש שוב.
4. **אל תקרא פריטי log אחד-אחד** — השתמש ב-`notion-search` עם פילטר שמחזיר רשימה מלאה ב-query אחד.
5. **אל תטען Projects/Contacts באופן מלא בהתחלה** — רק חפש ספציפית כשאתה באמת צריך לשייך פריט לפרויקט קיים.

**עשה:**

1. **טען Rules & Memory פעם אחת** בתחילת הריצה (כולל writing_style).
2. **שלוף את כל הפריטים הממתינים ב-query אחד.**
3. **לכל פריט — טפל בו על פי ה-Raw Content שכבר קיים**, בלי קריאות נוספות.

### 8. 🔁 CHECKPOINT STRATEGY

אחרי **כל משימה שנוצרת**:
1. עדכן מיידית את פריט ה-log: `Triage Status = classified`, `Task ID = <id>`
2. כל 3-5 משימות — עדכן Run Session עם counts נוכחיים
3. זה מבטיח שאם הריצה קורסת באמצע, לא נאבד את מה שכבר עובד — הריצה הבאה תמשיך מאיפה שעצרנו.

### 9. ⏭️ SKIP WHAT'S ALREADY DONE

- **STEP 3.FIRST (לימוד סגנון):** בדוק ב-Rules & Memory אם `Category=writing_style_he` וגם `Category=writing_style_en` קיימים. אם שניהם קיימים — **דלג על כל STEP 3.FIRST**.
- **לפני יצירת משימה:** חפש ב-Tasks לפי Source ID — אם קיימת, עדכן במקום ליצור חדשה.

### 10. ללא הגבלת כמות פריטים

**אל תפסיק אחרי X פריטים.** המטרה היא לטפל בכל הפריטים הממתינים ב-log. אם בכל זאת הריצה נעצרת באמצע מסיבה כלשהי — ה-checkpoints ידאגו שהפריטים שטופלו נשמרו, וה-Classifier הבא ימשיך את היתרה.

---

# PART 1 — EMAIL + DRIVE COLLECTOR

**מתי לרוץ:** `prompt contains "PART1"`

## STEP 1.0 — STARTUP

1. צור Run Session עם Run Type = COLLECTOR
2. טען את כל הכללים מ-Rules & Memory שבהם `Active = TRUE`:
   - skip rules → יישום בטריאז'
   - bot rules (WhatsApp) → לא רלוונטי ל-Part 1
3. טען את כל `Source ID` הקיימים ב-Processing Log (למניעת כפילויות)

## STEP 1.1 — חלון זמן

| מקור | ONBOARDING (Tasks ריק) | ריצה רגילה |
|---|---|---|
| Gmail | 3 ימים בכל ריצה עד 30 יום | מאז הריצה האחרונה |
| Drive | 30 יום | שעה אחרונה |
| Calendar | 7 ימים קדימה + 3 ימים אחורה | 7 ימים קדימה + 3 ימים אחורה |

**ONBOARDING של Gmail — חלון מתקדם:**
1. בדוק ב-Processing Log מה התאריך הישן ביותר עם `Source = gmail`
2. חלון של 3 ימים שמסתיים בתאריך הזה (או "היום" אם ריק)
3. סרוק רק 3 ימים אלה
4. Summary: "עבד חלון X עד Y, נותרו Z ימים ל-onboarding"

## STEP 1.2 — איסוף

### Gmail

**Query חובה:**
```
after:YYYY/MM/DD before:YYYY/MM/DD -to:office@maor.org -from:outbox@maor.org -from:officetest@maor.org -in:drafts
```

חפש בשני החשבונות: `chanoch@maor.org` + `chanoch@kinus.info`.

### Drive

```
parentId = '1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' and modifiedTime >= 'YYYY-MM-DDTHH:MM:SSZ'
```

- `pageSize: 10`, `excludeContentSnippets: true`
- לכל PDF: `read_file_content` לקבלת תוכן מלא

### Google Calendar

**טווח:** 7 ימים קדימה + 3 ימים אחורה (לפולו-אפ אחרי פגישות).

**חשבון:** chanoch770@gmail.com (primary calendar).

**סינון:**
- ✅ **כלול** אירועים עם `attendees` (פגישות עם אחרים)
- ✅ **כלול** אירועים עם כותרת שנשמעת כמשימה ("Call X", "Deadline Y", "Pay Z")
- ❌ **דלג** אירועים חוזרים — רק מופע ראשון כל תקופה (השתמש ב-recurringEventId לזיהוי)
- ❌ **דלג** אירועים מסומנים `private`
- ❌ **דלג** על כללי skip מ-Rules & Memory (לדוגמה "שבת", "חופש")

**לוגיקה:**
- **אירוע עתידי עם attendees** → `pending_deep_classify` עם Raw Content הכולל:
  - כותרת, מיקום, שעות התחלה/סיום
  - רשימת משתתפים (שמות + אימיילים)
  - description של האירוע
  - Reply To Context: "מחר ב-10:00 | 3 משתתפים"
- **אירוע שעבר (3 ימים אחורה) עם attendees** → `pending_deep_classify` עם תגית "follow-up"
  - ה-classifier יציע משימה: "פולו-אפ אחרי פגישה עם X"
- **תזכורת פרטית עם כותרת task-like** (לדוגמה "Pay rent") → `pending_deep_classify`

**זיהוי אירועים שכבר ב-log:**
- לפני הוספה — חפש `Source ID = <eventId>` ב-Processing Log
- אם קיים → דלג (תזכורת שהזנחת או כבר סווגה)

## STEP 1.3 — TRIAGE

לכל פריט, החלט אחד מארבעה:

### (א) SKIPPED_HARD_RULE
- recipient = office@maor.org
- sender = outbox@maor.org / officetest@maor.org
- Gmail label = DRAFT
- כלל skip אחר מ-Rules & Memory

→ **לא נכנס ללוג כלל.**

### (ב) SKIPPED_SPAM
- sender מכיל `noreply` / `no-reply`
- subject/body מכיל `unsubscribe`
- newsletter / marketing / promotion
- מאפייני ספאם ברורים

→ נכנס ללוג עם:
- Classification: `SKIPPED_SPAM`
- Triage Status: `skipped_spam`
- **בלי Raw Content**

### (ג) pending_deep_classify (רוב הפריטים)
→ נכנס ללוג עם:
- Classification: `pending_classify`
- Triage Status: `pending_deep_classify`
- **Raw Content מלא** (עד 3000 תווים)
- Attachments Info אם יש

### (ד) Calendar events
- אירועים עם attendees → `pending_deep_classify` עם Raw Content
- הסבר ב-Classification Reason: "calendar event, meeting/follow-up candidate"

## STEP 1.4 — כתיבה ל-Processing Log

כל 5 פריטים, לא לצבור.

## STEP 1.5 — סיום

עדכן Run Session:
- Gmail Processed, Drive Processed
- Skipped Count
- Total Items
- Summary, Errors Log
- Status: completed / partial / failed

---

# PART 2 — WHATSAPP CONVERSATION ANALYZER

**מתי לרוץ:** `prompt contains "PART2"`

## STEP 2.0 — STARTUP

1. צור Run Session עם Run Type = COLLECTOR (sub-category: whatsapp)
2. טען מ-Rules & Memory:
   - bot rules (Category = bot) → סינון הודעות
   - spam_pattern rules → סינון

## STEP 2.1 — טעינת הקובץ

**חובה `download_file_content`:**
```
file_id: <spreadsheet_id>
exportMimeType: 'text/csv'
```

**אל תנסה `read_file_content` — הקובץ גדול מדי.**

## STEP 2.2 — סינון ראשוני

סנן בשלבים:

1. **זמן:** רק הודעות מ-48 שעות אחרונות (ריצה רגילה) / שבוע (ראשונה)
2. **בוטים:** הסר לפי `From (Phone)` ו-`From Name` מול ה-bot rules
3. **Message Type:** דלג על `reaction` (ריאקציה של אמוג'י)

## STEP 2.3 — קיבוץ לשיחות

- קבץ לפי `Chat ID`
- מיין כל שיחה לפי `Timestamp`
- טען **20 ההודעות האחרונות** של כל שיחה (הקשר)

## STEP 2.4 — זיהוי סטטוס שיחה

**לכל שיחה** — הפעל AI classifier עם prompt:

```
SYSTEM: You analyze WhatsApp conversations for Chanoch Chaskind.
Given the last 20 messages, classify the conversation status.

Output JSON only:
{
  "status": "NEEDS_RESPONSE|WAITING_REPLY|PERSONAL_REMINDER|CLOSED|NOISE",
  "topic": "short Hebrew description of topic",
  "urgency": "urgent|high|medium|low",
  "last_msg_summary": "brief summary of last message",
  "suggested_actions": ["action1", "action2", "action3"],
  "ideal_response_time": "morning|afternoon|evening|none",
  "context_summary": "2-3 sentence Hebrew summary of conversation"
}

Rules:
- NEEDS_RESPONSE: last msg incoming, is question/request, >4h old
- WAITING_REPLY: last msg outgoing, was question, >24h no response
- PERSONAL_REMINDER: contains reminder/task for user (ignore responses)
- CLOSED: last msg is reaction/thanks/ok
- NOISE: bot/automated (add to rules suggestion)

Actions catalog:
draft_reply_he, draft_reply_en, draft_whatsapp_he, draft_whatsapp_en,
send_whatsapp, summarize_history, find_in_emails, check_past_handling,
find_contact_details, schedule_meeting, set_reminder, forward_to_chava,
financial_advisor, call_preparation
```

USER message: 20 ההודעות האחרונות של השיחה.

## STEP 2.5 — טיפול לפי סטטוס

| סטטוס | פעולה |
|---|---|
| **NEEDS_RESPONSE** | צור משימה 🔴 ב-Tasks עם Due Date = מחר 9:00 |
| **WAITING_REPLY** | צור משימה 🟠 פולו-אפ עם Due Date = היום 20:00 |
| **PERSONAL_REMINDER** | צור משימה 💡 עם Due Date = היום 20:00 |
| **CLOSED** | לוג בלבד (INFORMATIONAL) — אופציונלי |
| **NOISE** | אם לא בוט מוכר → הוסף כלל חדש (ראה STEP 2.6) |

**פורמט משימה מ-WhatsApp:**
```
Title: [אמוג'י] [שם] — [נושא]
Source: whatsapp
Source ID: Chat ID
Source Link: https://wa.me/[phone]
Priority: [לפי urgency]
Due Date: [לפי הסטטוס]
Category: maor/personal
Status: pending_approval

Description:
הקשר:
[context_summary]

ההודעה האחרונה:
"[last_msg_summary]"

AI Actions Catalog: [JSON של 2-3 suggested_actions]
Contact Person: [שם + מספר]
```

## STEP 2.6 — זיהוי בוטים אוטומטי

אם שיחה = רק הודעות incoming + תבנית חוזרת של דיווח/התראה (לא דיאלוג):
- הוסף כלל חדש ב-Rules & Memory:
  - Trigger: "WhatsApp sender = [phone]"
  - Rule Type: skip
  - Category: bot
  - Created By: claude
  - Reason: "זיהוי אוטומטי — התראות חד-צדדיות"

## STEP 2.7 — סיום

עדכן Run Session:
- WhatsApp Processed (מספר שיחות שנותחו)
- Tasks Created (NEEDS_RESPONSE + WAITING_REPLY + PERSONAL_REMINDER)
- Rules Added (זיהוי בוטים אוטומטי)

---

# PART 3 — DEEP CLASSIFIER

**מתי לרוץ:** `prompt contains "PART3"`

## STEP 3.0 — STARTUP (חסכני!)

**קריאה אחת בלבד בהתחלה:**

1. צור Run Session עם Run Type = CLASSIFIER
2. טען Rules & Memory ב-query אחד:
   - `notion-fetch` על Rules & Memory data source
   - שמור את התוצאה במשתנה — כולל skip rules, writing_style_he, writing_style_en
   - **אל תחזור לחפש שוב באמצע הריצה** — יש לך את הכל

**בדיקה אם צריך STEP 3.FIRST:**
- אם `writing_style_he` וגם `writing_style_en` קיימים ב-Rules → **דלג על STEP 3.FIRST לחלוטין**
- המצב הנוכחי: שניהם כבר קיימים (נלמדו ב-21/4/2026). **אין צורך ב-STEP 3.FIRST.**

**אל תעשה:**
- ❌ אל תטען schemas של databases — הם ב-CLAUDE.md
- ❌ אל תטען Projects/Contacts באופן מלא — רק חפש ספציפית כשנדרש שיוך
- ❌ אל תחפש שוב Rules & Memory באמצע — כבר טענת בהתחלה

## STEP 3.FIRST — לימוד סגנון (🔕 בד"כ לא רץ)

**בדוק ב-Rules & Memory (מהטעינה ב-STEP 3.0) — אם `writing_style_he` וגם `writing_style_en` קיימים, דלג לגמרי.**

רק אם חסר אחד מהם:
1. `search_threads` עם query `from:chanoch@maor.org שלום` (עברית) או `from:chanoch@maor.org Thank you` (אנגלית) — 10 תוצאות
2. השתמש ב-snippets מ-search_threads (אל תקרא גוף מלא)
3. AI מייצר פרופיל (~150 מילים)
4. שמור ב-Rules & Memory
5. **סיים את הריצה** — סמן Run Session `completed, writing_style learned, classification deferred`

## STEP 3.1 — שליפת פריטים ממתינים (query אחד!)

**חובה — query אחד בלבד:**

השתמש ב-`notion-search` על Processing Log data source עם:
- data_source_url: `collection://d47bac97-2e3f-44d5-9b4b-d93405035c7a`
- query: "pending_deep_classify"

זה מחזיר את כל הפריטים עם `Triage Status = pending_deep_classify` **ב-response אחד עם ה-Raw Content**.

**אין צורך ב:**
- ❌ 5 ניסיונות חיפוש בניסוחים שונים
- ❌ `notion-fetch` נפרד לכל פריט
- ❌ הגבלת מספר פריטים — טפל בכולם

**סדר טיפול:** FIFO — הישן ביותר ראשון (לפי Date Received).

## STEP 3.2 — טיפול בכל פריט (loop)

**לכל פריט ברשימה (מ-STEP 3.1):**

1. **בדיקת כפילות** (חיפוש קצר):
   - אם יש `Source ID`, חפש ב-Tasks לפי Source ID
   - אם קיים — עדכן את המשימה הקיימת (אל תיצור חדשה)
   
2. **סיווג עם AI** — השתמש ב-Raw Content שכבר יש לך (מ-STEP 3.1)

3. **צור/עדכן משימה** ב-Tasks

4. **עדכן מיידית את פריט ה-log:**
   - Triage Status = classified
   - Task ID = ה-ID החדש
   - Classification = ACTIONABLE / INFORMATIONAL

5. **כל 3-5 משימות** — עדכן Run Session עם counts (checkpoint).

**אל תעשה באמצע ה-loop:**
- ❌ חיפוש היסטוריה של 14 יום
- ❌ טעינת Rules & Memory מחדש
- ❌ fetch של schemas

## STEP 3.3 — פורמט ה-AI prompt לסיווג

```
SYSTEM: You are classifier+task builder for Chanoch Chaskind.

Classify: ACTIONABLE or INFORMATIONAL.

ACTIONABLE = requires real action or decision.
INFORMATIONAL = useful but no action needed.

For ACTIONABLE, output JSON:
{
  "classification": "ACTIONABLE",
  "reason_he": "short reason",
  "task": {
    "title_he": "clear specific title - NOT 'Email from X'",
    "priority": "urgent|high|medium|low",
    "due_date": "YYYY-MM-DD|null",
    "description_he": "FULL context: numbers, dates, contacts, stakes, consequences",
    "contact_person": "name + phone + email if mentioned",
    "category": "maor|personal",
    "tags": ["payments", "legal", "family", "tech", "mortgage", "maor"],
    "suggested_actions": ["action1", "action2", "action3"]
  }
}

For INFORMATIONAL:
{
  "classification": "INFORMATIONAL",
  "reason_he": "short reason"
}

Priority rules:
- urgent: deadline today/tomorrow, overdue, legal, payment blocked
- high: deadline <7 days, payment failure
- medium: <30 days
- low: no deadline

Actions catalog (pick 2-3 most relevant):
Communication: draft_reply_he, draft_reply_en, draft_whatsapp_he, 
              draft_whatsapp_en, send_email, send_whatsapp
Research: summarize_history, find_in_emails, check_past_handling, 
          find_contact_details
Management: schedule_meeting, set_reminder, forward_to_chava, 
            create_drive_folder
Financial: financial_advisor, call_preparation, 
           draft_settlement_request, open_payment_page
```

USER message: כל השדות מ-Processing Log + Raw Content + context מ-STEP 3.2.

## STEP 3.4 — עיבוד לפי סיווג (עם CHECKPOINTS)

**🔁 אחרי כל פריט — עדכן את ה-log מיידית.**

### INFORMATIONAL
1. עדכן ב-log:
   - Classification: `INFORMATIONAL`
   - Triage Status: `classified`
   - Action Taken: `logged_only`
2. ✅ **Checkpoint:** הפריט הושלם, עובר לבא.

### ACTIONABLE
1. **מניעת כפילויות:** חפש ב-Tasks לפי `Source ID` — עדכן אם קיים
2. **צור Task** (עם כל השדות — Title, Description, Priority, Due Date, Category, Tags, Contact Person, AI Actions Catalog, Source ID, Source Link, Status=pending_approval, Action Status=idle, Update Log)
3. **עדכן log מיידית** (זה ה-checkpoint):
   - Classification: `ACTIONABLE`
   - Triage Status: `classified`
   - Action Taken: `task_created`
   - Task ID: ה-ID של המשימה החדשה
4. **אחרי כל 2 משימות** — עדכן Run Session: `Tasks Created += 2`, זה מבטיח שאם נתקעים — יודעים כמה הספקנו

**⏭️ דלג על:**
- יצירת Projects / Contacts אוטומטית — זה לריצה נפרדת בעתיד
- חיפוש "Linked Sources" עמוק — אופציונלי, רק אם יש זיהוי ברור (אותו Source ID prefix)

## STEP 3.5 — זיהוי מסמכים קשורים (אופציונלי — דלג אם חורגים מ-budget)

אם משימה חדשה מאימייל, חפש ב-log פריטי Drive מאותו שולח/נושא (קריאה אחת!).
אם נמצאו — עדכן `Linked Sources` ב-Task.

## STEP 3.5 — זיהוי מסמכים קשורים

אם משימה חדשה מאימייל, חפש ב-log פריטי Drive מאותו שולח/נושא.
אם נמצאו — עדכן `Linked Sources` ב-Task.

## STEP 3.6 — טיפול בכישלונות classification

אם AI classifier לא החזיר תשובה תקפה:
- Increment `Classification Retry Count` בדף log (שדה זמני במחשב, לא ב-Notion)
- נסה שוב עד 3 פעמים בין ריצות
- אחרי 3 כישלונות: עדכן ב-log: `Classification Reason = "נכשל 3 פעמים, דורש בדיקה ידנית"`

## STEP 3.7 — עיבוד אישורים ופידבק

### מ-Tasks:
| Your Approval | פעולה |
|---|---|
| approve | Status → inbox. נקה Your Approval. |
| reject | אם יש Your Feedback → הוסף Rule. Status → cancelled. |
| snooze | Status → snoozed. Due Date → מחר. |
| edit | השאר pending_approval. |

### מ-Processing Log:
- `Your Feedback` מלא ו-`Feedback Processed = FALSE`:
  - המר לכלל חדש ב-Rules & Memory
  - סמן Feedback Processed = TRUE

**מקרה מיוחד — "לא ספאם":**
- Triage Status → `pending_deep_classify`
- Classification → `pending_classify`
- הוסף Rule: אל תסווג הודעות כאלה כספאם

## STEP 3.8 — סיום

עדכן Run Session **חובה** (גם אם לא הספקת הכל):

| שדה | ערך |
|---|---|
| Status | `completed` אם סיימת את כל ה-pending, `partial` אם נותרו, `failed` אם קרס |
| Ended At | עכשיו |
| Duration Minutes | חישוב מ-Started At |
| Tasks Created | סך משימות חדשות |
| Tasks Updated | סך משימות מעודכנות |
| Actionable Count | סך ACTIONABLE שסווגו |
| Informational Count | סך INFORMATIONAL |
| Rules Added | סך כללים חדשים |
| Summary | "טופלו X מתוך Y. נותרו Z ל-ריצה הבאה." |
| Errors Log | כל timeout/שגיאה |

**🚨 זה הצעד הכי חשוב — גם אם נגמרים טוקנים, חייב לסגור את ה-Run Session. אל תישאר `running` לנצח.**

---

# PART 4 — ACTION EXECUTOR

**מתי לרוץ:** `prompt contains "PART4"`

## STEP 4.0 — STARTUP

1. צור Run Session עם Run Type = CLASSIFIER (sub-category: executor)
2. טען מ-Rules & Memory: writing_style_he, writing_style_en, bot rules

## STEP 4.1 — שליפת משימות ממתינות

שלוף מ-Tasks כל משימה עם:
- `Action Status = pending` OR `Action Status = failed AND Action Retry Count < 3`

## STEP 4.2 — ביצוע לכל משימה

עדכן Action Status = running בתחילת ביצוע.

### פעולות לפי Requested Action:

---

### draft_reply_he / draft_reply_en

**תהליך:**
1. קרא את המשימה + Raw Content המקורי מ-Processing Log
2. טען writing_style_he / writing_style_en מ-Rules
3. הפעל AI:
```
SYSTEM: Draft an email reply in [Hebrew|English] for Chanoch.

Writing style profile:
[style from Rules]

Original message:
[raw content from log]

Task context:
[task description]

Output:
- Subject: [subject line]
- Body: [full email]

Keep tone consistent with style profile.
```
4. צור Gmail Draft דרך Gmail MCP
5. שמור:
   - Action Result: "טיוטה מוכנה ב-Gmail Drafts: [subject]"
   - Draft Link: URL של ה-draft

---

### draft_whatsapp_he / draft_whatsapp_en

**תהליך:**
1. קרא Raw Content + הקשר השיחה
2. הפעל AI עם writing style
3. **אל תשלח** — שמור רק ב:
   - Action Result: [הטקסט המלא]

---

### send_email

**דרוש שיש Draft קיים** (מ-draft_reply).

**תהליך:**
1. בדוק `Draft Link` — אם אין, כישלון
2. שלח את ה-draft דרך Gmail MCP
3. שמור Action Result: "נשלח ב-HH:MM"

---

### send_whatsapp

1. בדוק Action Result של draft_whatsapp
2. שלח לnמס' ב-Source Link/Contact
3. Action Result: "נשלח ב-HH:MM"

---

### summarize_history

1. חפש מ-log + Tasks כל ההתכתבות עם השולח ב-60 יום
2. הפעל AI:
```
SYSTEM: Summarize history with [contact] for Chanoch.
Include: topics, status of each issue, open items, patterns.
Hebrew, 200-400 words.
```
3. Action Result: [הסיכום]

---

### find_in_emails

1. חפש Gmail לפי keywords מהמשימה + מ-`Custom Action` אם יש
2. סכם 5 התוצאות הרלוונטיות ביותר
3. Action Result: [ממצאים]

---

### check_past_handling

1. חפש ב-Tasks משימות סגורות מאותו נושא/שולח
2. סכם: מה עשיתי, איך פתרתי, כמה זמן לקח
3. Action Result: [סיכום]

---

### find_contact_details

1. חפש ב-Contacts לפי שם
2. אם לא נמצא — חפש Gmail/WhatsApp לפרטים
3. Action Result: שם, טלפונים, אימיילים, חברה

---

### schedule_meeting

1. הפעל AI להציע זמנים פנויים (בדוק Calendar)
2. צור אירוע ב-Calendar (tentative)
3. Action Result: "פגישה נקבעה: [פרטים]"

---

### set_reminder

1. קרא מ-`Custom Action` או מ-Description — באיזו שעה
2. הוסף אירוע Calendar
3. Action Result: "תזכורת נוצרה ל-[תאריך+שעה]"

---

### forward_to_chava

1. בנה הודעת WhatsApp מסוכמת ל-חווה:
```
[שם] - [נושא]
[סיכום קצר]
[מה צריך לעשות]
```
2. שלח ל-+17326660770
3. Action Result: "הועבר לחווה ב-HH:MM"

---

### create_drive_folder

1. צור תיקייה חדשה ב-Drive עם שם הנושא
2. Action Result: "תיקייה נוצרה: [link]"

---

### financial_advisor

**הכי מתקדמת.**

1. טען את כל ההקשר הפיננסי מ-log + Tasks (אותו שולח/נושא)
2. טען financial_preference rules
3. הפעל AI:
```
SYSTEM: You are financial advisor for Chanoch. 
Analyze the situation and recommend optimal course of action.

Context: [full context]
Task: [description]
History: [past similar cases]

Output:
- Analysis (2-3 paragraphs Hebrew)
- Recommended approach
- Specific numbers/amounts (if settlement)
- Risks
- Draft action (email/call prep)
```
4. Action Result: [המלצה מפורטת]

---

### call_preparation

1. קרא את המשימה + היסטוריה
2. הפעל AI:
```
SYSTEM: Prepare Chanoch for phone call with [contact].
Output in Hebrew:
- Purpose of call
- Key points to mention
- Questions to ask
- Anticipated objections + responses
- Goal of call
```
3. Action Result: [ההכנה]

---

### draft_settlement_request

1. קרא הקשר + סכומים קודמים
2. חפש ב-past Tasks — מה עבד בעבר
3. הפעל AI ליצור מייל בקשת פשרה מנומק
4. צור Gmail Draft
5. Action Result: "טיוטה מוכנה ב-Gmail: [subject]"

---

### open_payment_page

1. זהה מ-Description מה סוג התשלום
2. Action Result: "קישור לתשלום: [URL]"

---

### custom

1. קרא את `Custom Action`
2. הפעל AI להבין כוונה
3. בצע לפי הבנה
4. Action Result: [תוצאה]

---

## STEP 4.3 — עדכון סטטוס

**אם הצליח:**
- Action Status: completed
- Action Completed At: עכשיו
- הוסף שורה ב-Action History:
  - Task Reference: Task ID
  - Action Type: [type]
  - Status: completed
  - Summary: [קצר]
  - Result: [התוצאה]

**אם נכשל:**
- Action Status: failed
- Action Error: [סיבה]
- Action Retry Count: +1
- אם Retry >= 3: Action Status: failed_permanently
- הוסף שורה ב-Action History עם Status: failed

## STEP 4.4 — סיום

עדכן Run Session:
- Tasks Updated = סה"כ משימות שטופלו
- Errors Count = כישלונות

---

## SCHEMAS — תזכורת

### Tasks — שדות רלוונטיים לפעולות
`Title`, `Status`, `Priority`, `Due Date`, `Category`, `Tags`, `Source`, `Source ID`, `Source Link`, `Reply To Context`, `Description`, `Contact Person`, `AI Actions Catalog`, `Linked Sources`, `Your Approval`, `Your Feedback`, `Notes`, `Update Log`, **`Requested Action`**, **`Custom Action`**, **`Action Status`**, **`Action Requested At`**, **`Action Completed At`**, **`Action Result`**, **`Action Error`**, **`Action Retry Count`**, **`Draft Link`**

### Rules & Memory
`Trigger`, `Rule Type`, `Category`, `Action`, `Reason`, `Active`, `Created By`, `Your Feedback`

### Action History
`Action Title`, `Task Reference`, `Action Type`, `Status`, `Requested At`, `Completed At`, `Summary`, `Result`
