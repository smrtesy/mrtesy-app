---
name: chochom-setup
description: משימה 1 בתוכנית ai chochom — להקים את סביבת התוכנית ברפו-הבית.
---
עברית מול המשתמש; קוד/נתיבים באנגלית. **קרא קודם:** `docs/ai-chochom-plan.md` —
בלוק T1 (קלט · פלט · "גמור כאשר" · מפת התוצרים) — ואל תאלתר נתיבים. סוג: 🤖 קלוד עושה הכול.

## מה עושים
קרא את docs/ai-chochom-plan.md — בלוק T1 + "מפרט רפו-הבית (תבנית ו)". בצע:
1. ודא ש-docs/ai-chochom-plan.md עדכני על main וש-CLAUDE.md מפנה אליו (סעיף "תוכנית ai chochom").
2. העתק research.sh / research-gate.sh / research-guard.sh מ-video-lab, חווט ב-.claude/settings.json (PreToolUse: WebSearch|WebFetch|Bash→gate ; Stop→guard), מכסה RESEARCH_GATE_FREE=10. ודא .claude/research/ ב-.gitignore.
3. ודא שכל 24 הסקילים chochom-* קיימים, וצור תיקיות docs/ai-chochom/{decisions,eval,marketing}.
4. חמש watchdog (longtask.sh arm + Routine).
5. עבור על "בדיקת-סיום להקמה" סעיף-סעיף, כולל אימות שמשתנה הסביבה SMRTPLAN_PLAN_ID_CHOCHOM קיים (POST לדיווח-כרטיס עובר).
6. מזג ל-main לפי כללי הדחיפה.

## כללים תמיד
- אישור-עלות לפני כל הרצה בתשלום (עד $5 בתקציב-שלב מאושר → "כן" בסשן; מעל → משימת-אישור).
- תוצר-רפו לא גמור עד שהוא על `main` לפי כללי הדחיפה, ובדיקת-הצרכן עברה.
- בסיום — דיווח סטטוס לכרטיס המשימה.

## ❓ אם משהו לא מובן — שאל את קלוד
תקוע? כתוב בצ'אט מה לא ברור. קלוד יקרא את `docs/ai-chochom-plan.md` (בלוק T1)
ואת הסקיל הזה, ויסביר צעד-אחר-צעד בעברית פשוטה בלי ז'רגון. פרומפט מוכן:
> `אני אוחז במשימה 1 בתוכנית ai chochom, לא מובן לי [כתוב מה לא מובן]`
