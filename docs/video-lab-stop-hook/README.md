# ה-hook המאוחד לניתוב-לפי-משתמש — התקנה ב-video-lab

חבילת ההתקנה של ה-Stop hook **המאוחד** (smrtTask + smrtPlan, ניתוב לפי משתמש)
לרפו **`video-lab`**. הקבצים נשמרים כאן, ב-`mrtesy-app` תחת
`docs/video-lab-stop-hook/hooks/`, רק כדי שיהיה להם קישור יציב ב-GitHub לפי
הקונבנציה של הרפו הזה — הם **לא רצים** מכאן. יש להעתיק אותם לרפו `video-lab`.

> **זה מחליף** את ה-hook הישן של video-lab (`video-lab-session-report.sh` +
> `post-session-report.sh`, שהוסרו מכאן). ה-hook המאוחד הוא על-קבוצה שלו: הוא
> עושה כל מה שהישן עשה (דיווח smrtPlan למשימת ה-`in_progress`) **ועוד** — ניתוב
> מנהל/עובד, שאלת זהות פעם ביום, והצעה למנהל. להשאיר את שניהם = דיווח כפול, לכן
> **הסר את הישן** בהתקנה.
>
> התכנון המלא: [`docs/user-routing-stop-hook-plan.md`](../user-routing-stop-hook-plan.md).

## מה זה עושה (תמצית)

בכל סוף-סשן ב-video-lab, ה-hook מנתב לפי מי פתח את הצ'אט:

- **מנהל** (`CLAUDE_CODE_USER_EMAIL == $SMRTTASK_MANAGER_CLAUDE_EMAIL`) → *שילוב*:
  אם יש משימת `in_progress` → עדכון המשימה (smrtPlan); אחרת → הצעה (smrtTask).
- **עובד** (חשבון משותף; נשאל **פעם ביום** "מה האימייל שלך ב-smrtTask?") →
  דיווח למשימת העובד **+ הצעה בתיבת המנהל** (dedup אחת לעובד/יום).
- **enable-gate:** הכל **כבוי** עד שמוגדר `SMRTTASK_MANAGER_CLAUDE_EMAIL`. בלי
  המשתנה — התנהגות זהה להיום (הצעה רגילה), אף אחד לא נשאל.

הבקאנד משותף (Railway) — אין צורך בשינוי צד-שרת ל-video-lab; ה-endpoints כבר חיים.

## התקנה

1. **העתק את 5 הקבצים** מ-`docs/video-lab-stop-hook/hooks/` כאן →
   `.claude/hooks/` ברפו `video-lab` (שמות זהים):
   - `session-start.sh`
   - `smrttask-session-proposal.sh`  ← ה-Stop hook
   - `post-session-summary.sh`       ← העוזר שהסוכן מריץ (הנתב)
   - `set-identity.sh`               ← רישום זהות העובד
   - `build-session-proposal.mjs`    ← בונה רשת-הביטחון
   - הרשאות הרצה: `chmod +x .claude/hooks/*.sh`

2. **הסר** את ה-hook הישן של video-lab אם קיים שם
   (`.claude/hooks/video-lab-session-report.sh`, `post-session-report.sh`).

3. **חווט ב-`.claude/settings.json` של `video-lab`** — `SessionStart` + `Stop`
   (אם כבר יש `Stop` שמצביע על הסקריפט הישן, החלף אותו):

   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh" } ] }
       ],
       "Stop": [
         { "matcher": "", "hooks": [ { "type": "command", "command": ".claude/hooks/smrttask-session-proposal.sh" } ] }
       ]
     }
   }
   ```
   (אם ל-video-lab יש כבר `session-start.sh` משלו לצרכים אחרים — מזג את הלוגיקה
   במקום להחליף. הקובץ כאן מריץ `npm install` רק אם קיים `package.json`, אז הוא
   בטוח גם ברפו שאינו Node.)

4. **הוסף ל-`.gitignore` של `video-lab`**: `​.claude/tmp/` (קובץ-זהות זמני לסשן).

5. **משתני סביבה** בסביבת ה-Claude Code של `video-lab` (אותו מקום שבו מוגדרים
   כבר `SMRTESY_BACKEND_URL`, `SMRTBOT_INTERNAL_SECRET`):
   - `SMRTESY_BACKEND_URL` = `https://mrtesy-app-production.up.railway.app`
   - `SMRTBOT_INTERNAL_SECRET` = הערך מ-Railway → השירות `mrtesy-app` → Variables
   - **להפעלה** (מפעיל את הניתוב): `SMRTTASK_MANAGER_CLAUDE_EMAIL` = אימייל
     הכניסה של המנהל ל-Claude Code.
   - אופציונלי: `SMRTTASK_MANAGER_EMAIL` = אימייל ה-smrtTask של המנהל (אחרת
     נופל ל-`SMRTTASK_USER_EMAIL`).

6. **בדיקה:** הרץ צ'אט web ב-video-lab מחשבון שאינו המנהל → הוא ישאל "מה האימייל
   שלך ב-smrtTask?" → ענה → סוף הסשן ינתב את הדיווח. חשבון המנהל לא יישאל.

## הכל guarded

לא סשן web / חסר secret או URL / חסר `node`/`curl`/`jq` / אין מנהל מוגדר →
no-op שקט שלא חוסם ולא מפיל תור. הסיכומים נכתבים ע"י הסוכן על מנוי ה-Claude —
אפס טוקני API בתשלום.
