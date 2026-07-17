# תוכנית: לכידת פתקי-SMS-לעצמי (כמו וואטסאפ)

## הבעיה (מאומת על נתוני פרודקשן)

כשהמשתמש שולח SMS **למספר שלו עצמו** (`+19293330248`) כפתק משימה — בדיוק
כמו שהוא עושה בוואטסאפ — הפתקים **לא הופכים למשימות**.

ראיה חד-משמעית: ב-07-13 נשלחו 8 פתקים ברצף. התוצאה:

| פתק | סיווג | משימות |
|---|---|---|
| להתקשר לשי עמר על שטר 500 שח | `superseded` | 0 |
| להזכיר לקמינקר | `superseded` | 0 |
| לנסות לשמוע מיוסי בריקמן אם יש עדכון | `superseded` | 0 |
| לשלוח אימייל לסמטנה על התרומה השנתית והשטר? | `superseded` | 0 |
| להשקיע בכסף 30 דקות | `superseded` | 0 |
| לעשות שעה על שבוע... | `superseded` | 0 |
| לבנות תוכנית לוידאו... | `superseded` | 0 |
| זמן קצוב | `informational` | 0 |

**8 פתקים → 0 משימות.**

## שורש הבעיה

הצינור של SMS מתייחס להודעה-לעצמי כמו לשיחה דו-צדדית רגילה:

1. **איחוד bursts** (`refreshSmsSourceThread` → `supersede`): כל הפתקים חוץ
   מהאחרון מסומנים `superseded` ולא מגיעים למסווג. (7 מ-8 אבדו כאן.)
2. **סיווג דו-צדדי**: הפתק ששרד נשפט כשיחה עם צד שני → "אין בקשה שמופנית
   למשתמש" → `informational` → אין משימה.
3. **מלכודת follow-up**: פתקים הם `outgoing`, אז גם אם היו הופכים למשימה הם
   היו נדחים (snooze ל-48 שעות) במקום להיכנס ל-inbox.

לעומת זאת, וואטסאפ מזהה `isSelfChat` ומפעיל זרימה ייעודית
(`emitSelfChatPerMessageSourceRows`): שורת `whatsapp_echo` **נפרדת לכל פתק**,
שכל אחת הופכת למשימה עצמאית מיד. ל-SMS אין את המקבילה הזאת.

הערת המפתחים בקוד וואטסאפ (`src/app/api/webhooks/whatsapp/route.ts:1770`)
מזהירה מפני הכשל הזה בדיוק: *"בלי הדילוג הזה, self-chat עם 8 פתקים יסוכם
כהחלטה אחת ו-7 מ-8 ילכו לאיבוד."*

## התיקון — מקבילה ל-`whatsapp_echo` עבור SMS

מוסיפים `source_type` חדש: **`sms_echo`**, שמתנהג בצינור בדיוק כמו
`whatsapp_echo`. אין CHECK על `source_messages.source_type`, אז הערך בטוח.

### 1. Webhook — `src/app/api/webhooks/sms/route.ts`

- **זיהוי המספר של המשתמש (אוטומטי):** על כל הודעה נכנסת, `payload.recipient`
  הוא המספר של המכשיר (מאומת: תמיד `19293330248`). כשהעמודה
  `sms_connections.display_phone_number` ריקה — נמלא אותה מהערך הזה
  (מנורמל לספרות). כך אין צורך בקלט מהמשתמש.
- **זיהוי הודעה-לעצמי:** peer (הנמען ב-outgoing / השולח ב-incoming) שספרותיו
  שווים למספר המכשיר.
- **ענף ייעודי:** כשמזוהה פתק-לעצמי — במקום `refreshSmsSourceThread`
  (המאחד), נכתוב שורת `source_messages` **אחת לכל הודעה**, מפתח
  `sms:self:<messageId>`, `source_type='sms_echo'`, `processing_status='pending'`,
  עם `raw_content` שכולל שורת "Self-note" (זהה לניסוח של וואטסאפ), בלי
  supersede/coalesce. גם backfill ל-200 הפתקים האחרונים (idempotent, כמו
  וואטסאפ) — כדי לשחזר את 8 הפתקים שאבדו.

### 2. Pipeline — `supabase/functions/ai-process/index.ts`

מטפלים ב-`sms_echo` בדיוק כמו `whatsapp_echo`:

| מקום | שינוי |
|---|---|
| `SOURCE_PRIORITY` | להוסיף `"sms_echo"` |
| `BODY_TEXT_FILTER` | להוסיף `source_type.eq.sms_echo` |
| `preClassify` | `whatsapp_echo` → מוסיפים `sms_echo` (מחזיר `needs_claude`, מדלג על check_followup) |
| `threadKey` | `sms_echo` → `null` (פתק עצמאי, בלי thread memory) |
| `isConversational` | לכלול `sms_echo` (מקבל את חוקי המסווג) |
| `selfNote` (analyzeWithMemory) | לכלול `sms_echo` → מוסיף את הקשר "פתק עצמי מכוון" |

חשוב: לא נחתום `metadata.lastDirection='outgoing'` על שורות echo (בדיוק כמו
וואטסאפ) — כך מלכודת ה-follow-up defer לא נדרכת, והמשימה נכנסת ל-inbox מיד.

### 3. UI (מינימלי)

- `src/components/smrttask/common/SourceLink.tsx` — לטפל ב-`sms_echo` (אייקון/תווית "פתק SMS", נופל חזרה ל-SMS).
- `src/app/[locale]/(app)/(smrttask)/log/LogPageClient.tsx` — תווית ליומן.
- מפתחות i18n חדשים ב-`he.json` + `en.json` באותו commit.

## מה לא משתנה

- OTP/קודי אימות עדיין מסוננים (`looksLikeOtp`) — פתק-לעצמי עובר את הבדיקה
  רק אחריה, כך שקוד שנשלח לעצמך לא ייצור משימה.
- הודעות SMS רגילות (דו-צדדיות) — הזרימה הקיימת נשארת כפי שהיא ועובדת.

## אימות אחרי המימוש

1. `npm run build` נקי.
2. פרוטוקול הבדיקה של CLAUDE.md (greps + סוכן-משנה).
3. בדיקת קצה-לקצה: לשלוח פתק לעצמי → לוודא ששורת `sms_echo` נוצרה, סווגה
   actionable, ונוצרה משימה ב-inbox (לא snoozed).
4. Backfill: לוודא ש-8 הפתקים מ-07-13 הופכים למשימות.

## פתוח להחלטה

- **Backfill של הפתקים הישנים** — לשחזר את 8 הפתקים מ-07-13 למשימות, או
  להשאיר אותם ולהתחיל נקי מכאן והלאה?
