# video-lab Stop hook — דיווח סטטוס אוטומטי ל-smrtPlan

## מה זה

שני קבצי hook שנועדו לרפוזיטורי **אחר** (`video-lab`), לא לרפוזיטורי הזה
(`mrtesy-app`). הם נשמרים כאן, תחת `docs/video-lab-stop-hook/`, רק כדי שיהיה
להם קישור יציב ב-GitHub לפי הקונבנציה של הרפו הזה (מסמכי תכנון/עיצוב
נשמרים ב-`docs/` ומקבלים לינק). הם **לא רצים** מכאן — יש להעתיק אותם
לרפו `video-lab` בפועל.

הרעיון: בכל סשן Claude Code ב-video-lab, בעצירה (Stop) הסוכן מדווח סטטוס
קצר על העבודה שנעשתה, והדיווח מתחבר אוטומטית בצד השרת למשימה שה-worker
המדווח מסומן אצלו כרגע כ-`in_progress` ב-smrtPlan — בלי לשלוח task id
מה-hook; השרת מוצא את המשימה לפי המשתמש + הארגון.

- **`video-lab-session-report.sh`** — ה-Stop hook עצמו. בעצירה הראשונה
  בכל turn-cycle הוא חוסם ומנחה את הסוכן לכתוב סיכום + סטטוס ולהריץ את
  הסקריפט הנלווה. בעצירה השנייה (`stop_hook_active=true`) הוא שולח ברקע
  (fire-and-forget) דיווח מינימלי בטוח (`status: "in_progress"`, סיכום
  גנרי) — כך שגם סשן שבו הסוכן לא הספיק לדווח משאיר עדיין עקבה.
- **`post-session-report.sh`** — הסקריפט שהסוכן מריץ כשהוא נחסם. מקבל
  שני ארגומנטים פשוטים: `"<סיכום>" "<סטטוס>"` כאשר סטטוס הוא אחד מתוך
  `in_progress` / `blocked` / `done`. בונה את גוף הבקשה עם `jq --arg`
  (escaping בטוח) ושולח POST.

שני הקבצים no-op לגמרי (יוצאים עם `exit 0` בלי לחסום כלום) אם חסר משתנה
סביבה, חסר `node`/`curl`/`jq`, או שזה לא סשן web (`CLAUDE_CODE_REMOTE_SESSION_ID`
לא מוגדר) — בדיוק כמו הדוגמה המקורית ב-`mrtesy-app`
(`.claude/hooks/smrttask-session-proposal.sh` +
`.claude/hooks/post-session-summary.sh`).

## איך מתקינים ב-video-lab (רפו אחר!)

1. להעתיק את שני קבצי ה-`.sh` מכאן:
   - `docs/video-lab-stop-hook/video-lab-session-report.sh` →
     `.claude/hooks/video-lab-session-report.sh` ברפו `video-lab`
   - `docs/video-lab-stop-hook/post-session-report.sh` →
     `.claude/hooks/post-session-report.sh` ברפו `video-lab`
   - לוודא הרשאות הרצה: `chmod +x .claude/hooks/*.sh`

2. להוסיף את החיווט הבא לקובץ `.claude/settings.json` של רפו `video-lab`
   (תחת `hooks.Stop` — אותו pattern בדיוק כמו ב-`mrtesy-app/.claude/settings.json`):

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/video-lab-session-report.sh"
             }
           ]
         }
       ]
     }
   }
   ```

   אם כבר קיים מפתח `hooks.Stop` אחר בקובץ, להוסיף אובייקט נוסף למערך
   ולא לדרוס את הקיים.

## משתני סביבה נדרשים (בסביבת ה-Claude Code של video-lab)

יש להגדיר את ארבעת אלה בסביבת ה-Claude Code (Environment) של video-lab —
לא ב-`.env` של הריפו:

| משתנה | למה |
|---|---|
| `FAL_KEY` | מפתח ה-API של fal.ai בו video-lab עצמו משתמש (לא קשור ל-hook, אבל נדרש שהסביבה תפעל). |
| `SMRTBOT_INTERNAL_SECRET` | הסוד המשותף שנשלח בכותרת `X-Cron-Secret` לאימות מול ה-backend. אפשר גם `CRON_SECRET` — ה-hook תומך בשניהם (`CRON_SECRET` קודם אם שניהם מוגדרים). |
| `SMRTESY_BACKEND_URL` | כתובת הבסיס של ה-Express backend (Railway) — ה-hook בונה ממנה `<SMRTESY_BACKEND_URL>/api/claude-session/task-report`. אפשר לחלופין להגדיר `SMRTPLAN_REPORT_URL` עם הכתובת המלאה של ה-endpoint ישירות. חובה לכלול `https://` בתחילת הכתובת. |
| `SMRTTASK_USER_ID` (או `SMRTTASK_USER_EMAIL`) | זיהוי המשתמש שהדיווח מוגש בשמו ב-smrtPlan, כשהוא שונה מהאימייל של ה-login ל-Claude Code. `SMRTTASK_USER_ID` עדיף (עוקף חיפוש לפי אימייל); `SMRTTASK_USER_EMAIL` הוא חלופה. בלי אחד מהם, ה-hook נופל בחזרה ל-`CLAUDE_CODE_USER_EMAIL`. |

הערכים המדויקים של `SMRTBOT_INTERNAL_SECRET` ו-`SMRTESY_BACKEND_URL`
נמצאים באותו מקום שבו הם מוגדרים עבור `mrtesy-app` — Railway → הפרויקט
→ שירות ה-backend → טאב **Variables**. יש להעתיק את אותם ערכים בדיוק
(אותו backend משותף, אותו endpoint `/api/claude-session/...`).

## חשוב: לסמן את המשימה "in_progress" ב-smrtPlan *לפני* פתיחת הסשן

מכיוון שה-backend מוצא את המשימה **לפי המשתמש + הארגון** ולא לפי task id
שנשלח מה-hook, על ה-worker לסמן ידנית ב-smrtPlan את המשימה שהוא עומד
לעבוד עליה כ-`in_progress` **לפני** שהוא פותח סשן Claude Code חדש
ב-video-lab. אם אין למשתמש אף משימה מסומנת `in_progress` בזמן הדיווח,
ה-endpoint מחזיר `attached:false` — זו לא שגיאה, אבל המשמעות היא שהדיווח
לא התחבר לאף משימה ספציפית.
