# smrtInfo — חבילת מסירה לסשן בנייה (Claude Code חדש)

מסמך זה נותן לחשבון Claude Code חדש את **כל** מה שצריך כדי לבנות את smrtInfo,
בלי להסתמך על ההקשר של הסשן הנוכחי. התכנון המלא: `docs/info-center-plan.md`.

---

## 0. מה לפתוח
- **Repo:** `smrtesy/mrtesy-app`
- **ענף:** להמשיך על `claude/org-info-center-tl52qy` (שם כבר יושבים מסמכי התכנון).
  אם הסשן החדש פותח ענף משלו — לבסס אותו על הענף הזה, לא על `main`.

---

## 1. פרומפט-פתיחה (להדביק בסשן החדש)
```
בנה את smrtInfo לפי docs/info-center-plan.md, על הענף claude/org-info-center-tl52qy
(אם נפתח ענף חדש — לבסס עליו). קרא קודם את CLAUDE.md ואת docs/info-center-plan.md.

התחל בשלב 1+2 (מיגרציה + רישום האפליקציה) והצג לי לפני שממשיכים לשרת ול-UI.
מנוע חילוץ העובדות בזמן ריצה ישתמש בסוננט (simpleCall(..., "sonnet")) עם קדם-סינון
זול, לפי §8.2 בתכנון. עקוב אחרי פרוטוקול ה-pre-push של ה-repo. ענה בעברית.
```

---

## 2. חיבורים (MCP / גישות) שהחשבון החדש צריך
| חיבור | לשם מה | פרטים |
|---|---|---|
| **גישת GitHub ל-`smrtesy/mrtesy-app`** | קריאה, commit, push לענף | הענף: `claude/org-info-center-tl52qy` |
| **Supabase MCP** | list_tables, בדיקת סכמה, יצירת מיגרציה, בדיקת RLS | project ref: `exjnlghuzuvqedlltztz` |
| (אופציונלי) Gmail/Drive MCP | רק אם רוצים לבדוק חילוץ על נתונים חיים | לא חובה לבנייה עצמה |

> הרשאת הרצת מיגרציה על פרודקשן: לפי CLAUDE.md, **לא** מריצים `apply_migration` על
> פרודקשן בלי אישור מפורש. הסשן ייצור קובץ מיגרציה תחת `supabase/migrations/` ואתה
> תריץ אותו (Supabase CLI) או תיתן אישור מפורש.

---

## 3. משתני סביבה / סודות להגדיר בסביבת ה-Claude Code החדשה
העתק מ-Railway (שרת) ו/או Supabase Secrets (edge). **לא להדביק ערכים במסמך הזה.**

| משתנה | לשם מה | מאיפה להעתיק |
|---|---|---|
| `ANTHROPIC_API_KEY` | קריאות Claude (חילוץ, בדיקות) | Railway env / Supabase Secrets |
| `VOYAGE_API_KEY` | embeddings (כבר בשימוש ל-knowledge_base) | Railway env |
| `SUPABASE_URL` / project ref | חיבור DB | Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | כתיבת מיגרציה/בדיקה service-role | Supabase project (סוד — בזהירות) |
| (אופציונלי) `SMRTBOT_INTERNAL_SECRET` + `SMRTESY_BACKEND_URL` | ל-Stop hook של smrtTask | Railway backend |

לבנייה+build בלבד לא חובה סודות ריצה — צריך רק גישת רשת ל-npm registry. הסודות
נדרשים כדי **לבדוק** חילוץ/embedding בפועל.

---

## 4. הגדרות סביבה (Claude Code on the web)
- **מדיניות רשת:** לאפשר יציאת HTTPS ל-npm registry (הבנייה מריצה
  `npm install && npm run build`). Node לפי `.node-version` שב-repo.
- **פרוטוקול pre-push:** נאכף אוטומטית דרך `CLAUDE.md` — build אמיתי (`npm run build`,
  לא רק tsc), greps, סוכן-review. אין צורך להזכיר לו; הוא יקרא.
- **Edge functions:** אם החילוץ נכנס ל-`ai-process` (Deno) — **deploy ידני**
  (`supabase functions deploy ...`), לא אוטומטי מ-push. ואל תשתמש ב-`https://esm.sh/...`
  (ראה CLAUDE.md — משתמשים ב-`npm:`/`jsr:`).

---

## 5. מה הסשן החדש יורש אוטומטית מ-CLAUDE.md (לא צריך לחזור עליו)
- **תשובות בעברית** תמיד.
- **פרוטוקול pre-push** (build/greps/סוכן-review, אפס ממצאים ביעד).
- **workflow דחיפה** (feature branch → merge `--no-ff` ל-main כשמאושר).
- **משמעת מיגרציות**, **i18n he/en יחד**, **`api()` client**, **org scoping /
  `requireApp`**, **service-role דרך `createAdminSupabaseClient()`**.
- **עקרונות מוצר:** שימור deep links מילה-במילה; UI מינימלי (חיפוש מכווץ כברירת מחדל).

---

## 6. סדר בנייה מומלץ (phases)
1. **מיגרציה** — `info_facts` (+ `embedding vector(1024)` + HNSW + RLS אישי/ארגוני) +
   `info_fact_history` + `info_context_profile` + הפונקציה `match_info_facts`.
2. **רישום אפליקציה** — הוספת `smrtinfo` ל-`apps` + `app_status`
   (כמו `20260713100000_register_smrtvault.sql`). → **עצור והצג למשתמש.**
3. **מודול שרת** `server/src/modules/smrtinfo` — `/info/ask`, `/info/facts` (CRUD),
   `/info/context-profile`, hook חילוץ (סוננט + קדם-סינון), נתיב הצעת-סיסמה→כספת.
4. **חיווט לצינור הסיווג** (`ai-process` / router).
5. **פרונטאנד** — מסך smrtInfo + רישום pane + מסך פרופיל הקשר + i18n.
6. **Backfill** חד-פעמי על היסטוריית `source_messages`.

---

## 7. הגדרת "בוצע" (Definition of Done)
- `npm run build` נקי; פרוטוקול pre-push עבר; סוכן-review בלי ממצאי HIGH/MED.
- שלוש שאלות-הבוחן עונות נכון עם מקור+קישור: ביטוח FPL (ארגוני), תשלום ביטוח יהודית
  (אישי), סיסמת קופצ'יק (הצעת-שמירה→כספת→חשיפה).
- סיסמאות: אף פעם לא ב-`info_facts`, לא ל-LLM מעבר לזיהוי; שמירה רק אחרי אישור.
- הבחנה אישי/ארגוני עובדת דרך פרופיל הקשר; "לא מסווג" ניתן לשיוך בלחיצה.

---

*נכתב 2026-07-15. נלווה ל-`docs/info-center-plan.md`.*
