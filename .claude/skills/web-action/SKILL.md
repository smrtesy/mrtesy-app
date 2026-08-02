---
name: web-action
description: סוכן שפועל באינטרנט בשם המשתמש — פותח חשבון בשירות, עובר אימות מייל/SMS אוטומטית, מחלץ API key ושומר בוואלט. הפעל כשהמשתמש מבקש "פתח לי חשבון ב-X / קח API key / תירשם בשבילי" ולשמור סוד בוואלט.
---
עברית מול המשתמש; קוד/נתיבים/פקודות באנגלית. **קרא קודם:** `docs/web-action-agent-plan.md`.

## מה זה
מפעיל דפדפן חי ב-backend (Railway) ונוהג אותו כמו משתמש: ממלא טופס-הרשמה,
**עובר אימות מייל (Gmail) ו-SMS (`sms_messages`) אוטומטית**, מחלץ את ה-API key
ושומר ב-smrtVault. הצומת האנושי היחיד: **CAPTCHA** (דרך ה-live-view).

## גבולות (קשיח)
- **אישור-אדם לפני יצירת חשבון, אישור-תנאים, וכל תשלום.** תשלום — לעולם לא אוטומטי.
- מפעילים **חשבונות של המשתמש**; מעדיפים **API רשמי** כשקיים; בלי עקיפת-הגנות.
- אישור-עלות (כלל CLAUDE.md) לכל הרשמה בתשלום.
- סודות: נשמרים דרך ה-endpoint לוואלט בלבד; **לא מדפיסים API key לצ'אט/לוג**.

## אימות + auth
כל הראוטים דורשים session של המשתמש. הנפק אותו:
```bash
A=$(curl -s -H "x-cron-secret: $SMRTBOT_INTERNAL_SECRET" \
  "${SMRTESY_BACKEND_URL%/}/api/claude-session/app-access?user_id=$SMRTTASK_USER_ID")
TOKEN=$(echo "$A" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
ORG=$(echo "$A" | python3 -c "import sys,json;print(json.load(sys.stdin)['org_id'])")
H=(-H "Authorization: Bearer $TOKEN" -H "X-Org-Id: $ORG" -H "Content-Type: application/json")
B="${SMRTESY_BACKEND_URL%/}/api/web-action"
```

## הזרימה
1. **צור סשן:** `curl -s "${H[@]}" -X POST "$B/sessions"` → קח `session.id` (=SID).
2. **נווט:** `curl -s "${H[@]}" -X POST "$B/sessions/$SID/navigate" -d '{"url":"https://..."}'`.
3. **ראה את הדף:** `curl -s "${H[@]}" "$B/sessions/$SID/screenshot"` → שדה `image` (data URL);
   שמור ל-png ופתח עם Read כדי לראות מה על המסך ולהחליט את הצעד הבא.
4. **פעל:** `-X POST "$B/sessions/$SID/act" -d '{"type":"fill","selector":"...","text":"..."}'`
   (סוגים: `fill`/`click`/`press`/`wait_for`). גלה סלקטורים מהצילום — אל תמציא.
5. **אימות מייל:** `curl -s "${H[@]}" "$B/verification/email?from=<domain>"` → `{code, link}`.
   יש `link` → נווט אליו; יש `code` → מלא אותו.
6. **אימות SMS:** `curl -s "${H[@]}" "$B/verification/sms"` → `{code}` → מלא. (תנאי: ההרשמה
   השתמשה במספר המחובר במערכת.)
7. **CAPTCHA:** אם בצילום יש CAPTCHA — **עצור, אמור למשתמש לפתוח את מסך `/web-action`,
   לבחור "קבל שליטה" ולפתור בעצמו**, וחכה לאישור שהמשיך, ואז המשך.
8. **חלץ מפתח ושמור בוואלט:** מצא את ה-API key בדשבורד (צילום), ואז:
   `-X POST "$B/vault/api-key" -d '{"label":"<שירות> API key","secret":"<KEY>","url":"<שירות>","username":"<email>"}'`.
   **אל תדפיס את ה-KEY לצ'אט.**
9. **סגור:** `curl -s "${H[@]}" -X DELETE "$B/sessions/$SID"`.

## מינימקס (מקרה-מבחן ראשון)
פלייבוק ייעודי: `docs/web-action/minimax.md`. **צעד 0:** ודא מול המשתמש שצריך חשבון
מינימקס **ישיר** — במערכת מינימקס כבר מגיע דרך fal (`FAL_KEY`), אז ייתכן שמיותר.

## כללים תמיד
- בסיום — שמור דיווח-סטטוס; ציין שם-שירות, מה נשמר בוואלט (בלי הסוד), ומה נדרש אדם.
- כישלון-אמת מדווח כמו שהוא; לעולם לא להציג כישלון כהצלחה.
