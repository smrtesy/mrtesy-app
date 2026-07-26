# קונסולת-מפעיל מעל צי חשבונות Claude — בדיקת היתכנות

> תאריך: 2026-07-24 · צרכן: שלב הבניה של קונסולת-המפעיל ב-mrtesy-app + החלטת go/no-go של המפעיל
> מקורות (מתוארכים לגישה 2026-07-24): מובאים ליד כל ממצא.

## סיכום מנהלים (רמזור)

| דרישה | מסקנה | הערה |
|---|---|---|
| מעבר/סיבוב בין חשבונות (מכניקה) | 🟢 ישים — **אך עדיף לקנות** | ראו § "קנייה במקום בנייה": Teams/Enterprise נותן זאת מנהלית |
| שליטה מרכזית על משתני כל חשבון | 🟢 ישים — **אך עדיף לקנות** | managed settings ארגוניים, במקום הזרקת-קונפיג עצמית |
| הפעלת עבודות (יצירת/תיקון תמונות) מהאפליקציה | 🟢 ישים | headless (`claude -p` / SDK) על טוקן המנוי; **כלל 2: אישור-עלות נשמר** |
| התראת **סיום** עבודה | 🟢 ישים | Stop hook / תוצאת SDK → push |
| **צפייה בתמלול המלא של סשן** (לא תקציר) | 🟢 ישים — **זול מהמשוער** | ה-hook כבר מקבל `transcript_path`; ראו § תיקון 2 |
| תמונת-מצב **אמיתית** על יתרת המגבלה | 🟡 ב-Pro/Max · 🟢 ב-Enterprise | Pro/Max: אין פיד ליתרה. Enterprise: Analytics API — ראו § תיקון 1 |
| התראה על **עצירה מחמת מגבלה** | 🟡 חלקי | אין אות מובנה; רק טקסט-שגיאה + watchdog מקדים |
| **סיבוב חשבונות כדי לעקוף מגבלות** | 🔴 סיכון ToS | מדיניות-השימוש מסמנת זאת כעקיפה |

---

## Q1 — האם יש דרך תוכניתית לקרוא את יתרת מגבלת-המנוי?

**מסקנה: לא לְיִתְרָה/איפוס. כן לְצריכה.**

- הפקודה `/usage` מציגה למנויי Pro/Max פסי-שימוש מול המכסה, אבל *"The figures are approximate and computed from local session history on this machine, so usage from other devices or claude.ai is not included."* — כלומר אינטראקטיבי, מקומי-למכונה, מקורב. ([costs](https://code.claude.com/docs/en/costs))
- **OpenTelemetry** הוא המנגנון התוכניתי היחיד שזורם בזמן-אמת: *"OpenTelemetry export works on every setup and is the only option that streams per-user token and cost metrics into your own observability stack in near real time."* המדדים: `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count`, ואירוע `claude_code.api_request` (עם `cost_usd`, `input_tokens`, `output_tokens`, `model`). מופעל ב-`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`. ([monitoring-usage](https://code.claude.com/docs/en/monitoring-usage))
- **מגבלה מפורשת (שני מקורות מסכימים):** אין מדד ל**יתרת מכסה, מגבלת-קצב, זמן-איפוס, או אירוע הגעה-למגבלה** ב-OTel. את אלה צריך לגזור בנפרד.
- ה-API לניתוח (Enterprise Analytics API / Claude Code Analytics API) קיים אך **רק ל-Teams/Enterprise/Console (חיוב-API)** — לא למנוי Pro/Max. ([costs](https://code.claude.com/docs/en/costs))

**מה זה אומר לקונסולה:** אפשר לבנות מד-"כמה נצרך" מדויק (OTel), ולהעריך יתרה מול תקרה ידועה. "תמונת-מצב אמיתית על היתרה" מהשרת — לא זמינה תוכניתית למנוי.

## Q2 — אות-מכונה לעצירה / מגבלה / איפוס?

**מסקנה: סיום-סשן קל; הגעה-למגבלה רק כטקסט.**

- **סיום עבודה:** Stop hook או תוצאת ה-SDK — אות נקי, קל להתריע עליו.
- **הגעה-למגבלה:** מופיעה כהודעת-שגיאה בשיחה — *"You've hit your session limit"* / *"...weekly limit"*, וההודעה מציינת מתי החלון מתאפס. ([costs](https://code.claude.com/docs/en/costs) → [errors](https://code.claude.com/docs/en/errors)). זהו טקסט שנתפס מזרם `--output-format stream-json`, **לא** אירוע מובנה.
- **אין** אירוע OTel ל"limit-reached" (Q1). מסתדר עם ההערה הקיימת ב-CLAUDE.md של video-lab: אין אות אמין ל"נעצרתי כי נגמרו הטוקנים" → הפתרון הקיים הוא watchdog/Routine מקדים.

## Q3 — עמדת ה-ToS על ריבוי חשבונות / אוטומציה (מכריע, ≥2 מקורות)

**מסקנה: אוטומציית Claude Code על המנוי — מותרת. סיבוב חשבונות כדי לעקוף מגבלות — דגל אדום.**

- **אוטומציה מותרת דרך Claude Code:** `claude setup-token` קיים במפורש ל-*"CI pipelines, scripts, or other environments where interactive browser login isn't available"* ומפיק טוקן OAuth לשנה. זו אוטומציה מסונקצנת. ([authentication](https://code.claude.com/docs/en/authentication))
- **תנאי-הצרכן:** *"You may not share your Account login information... or Account credentials with anyone else. You also may not make your Account available to anyone else."* וגם: גישה אוטומטית אסורה *"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"*; ואיסור reselling/pooling. ([consumer-terms](https://www.anthropic.com/legal/consumer-terms))
- **מדיניות-השימוש (מקור שני):** אסור *"Coordinate malicious activity across multiple accounts to avoid detection or circumvent product guardrails"* ו-*"Circumvent a ban through the use of a different account"*. ([usage policy](https://www.anthropic.com/legal/aup))

**פרשנות ישרה:**
- ✅ להריץ Claude Code headless על **חשבון המנוי שלך** דרך setup-token — מותר ומסונקצן.
- ⚠️ להחזיק כמה חשבונות שאתה בעליהם — לא אסור מפורשות, אבל אתה אחראי לכל פעילות בהם.
- 🔴 **לסובב בין חשבונות במטרה לעקוף את חלון-המגבלה** — זו בדיוק ה"circumvent limits / coordinate across multiple accounts" שהמדיניות מסמנת. סיכון אמיתי לחסימת חשבונות.
- 🔴 **לחשוף את החשבונות/הקיבולת ללקוחות** — "make your Account available to anyone else" + איסור pooling. אסור.

**המסלול המסונקצן להגדלת קיבולת:** usage-credits על המנוי (`/usage-credits`), או חיוב-API. לא סיבוב-חשבונות.

## Q4 — מכניקת אימות מרובה-חשבונות (מאושר ישים)

- קרדנציאלס נשמרים ב-`~/.claude/.credentials.json` (Linux, מצב 0600) / Keychain (mac); `CLAUDE_CONFIG_DIR` מעתיק את כל ספריית-הקונפיג. ([authentication](https://code.claude.com/docs/en/authentication))
- לכל חשבון: `claude setup-token` → טוקן שנה → מציבים ב-`CLAUDE_CODE_OAUTH_TOKEN`. **בחירת חשבון per-invocation** = החלפת משתנה-הסביבה, או `CLAUDE_CONFIG_DIR` נפרד לכל חשבון.
- סדר-קדימות מתועד; שים לב: `ANTHROPIC_API_KEY` גובר על המנוי — **לא להגדיר אותו** כשרוצים מנוי.
- **סייג:** טוקן setup-token *"can only make model requests"* — בלי Remote Control (‎--teleport/web) ובלי claude.ai connectors. הרצות-מודל headless עובדות; MCP מקומי עובד.

---

---

# בדיקה חוזרת (2026-07-24) — שני תיקונים לתוכנית

## תיקון 1 — חלק גדול מהתוכנית הוא **קנייה, לא בנייה**: Claude for Teams/Enterprise

הבדיקה הראשונה תכננה לבנות בעצמנו ניהול-צי (טוקן לכל חשבון, קונפיג מרכזי, אמידת-מכסה).
אבל אם העובדים הם **אנשים נפרדים**, זה בדיוק המוצר Teams/Enterprise — מנהלית, בלי קוד:

- **ניהול צי מרוכז:** *"Team members get access to both Claude Code and Claude on the web with centralized billing and team management."* ([authentication](https://code.claude.com/docs/en/authentication))
- **שליטה מרכזית על ההגדרות:** Enterprise מוסיף *"managed policy settings for organization-wide Claude Code configurations"* — זו הדרישה "שליטה על המשתנים של כל חשבון", כתכונה. ([authentication](https://code.claude.com/docs/en/authentication))
- **נראות שימוש:** דשבורד ניתוח ב-[claude.ai/analytics/claude-code](https://claude.ai/analytics/claude-code) + דוח-הוצאה פר-משתמש עם CSV. ([costs](https://code.claude.com/docs/en/costs))
- **🔑 נראות תוכניתית — סוגר את הפער שסימנתי 🟡:** *"on the Enterprise plan, the Enterprise Analytics API returns per-user usage and cost reports across Claude surfaces, including Claude Code"* — מפתח בהיקף `read:analytics` מ-[claude.ai/analytics/api-keys](https://claude.ai/analytics/api-keys). כלומר **פיד-שימוש פר-משתמש קיים — רק לא ל-Pro/Max.** ([costs](https://code.claude.com/docs/en/costs))
- **מכסות מוגדרות:** *"each member's Claude Code usage draws from a per-seat allowance that resets on a rolling five-hour window and a weekly window"* — תקרה ידועה, מה שהופך "נצרך מול תקרה" למדיד באמת. ([costs](https://code.claude.com/docs/en/costs))

**בונוס בטיחות:** בתצורה הזו **אינך מחזיק טוקנים של עובדים** — כל אחד בחשבונו, והראות מנהלית. זה מסיר את חיכוך ה-ToS לגמרי.

**עלות/סייג:** כרוך בתשלום פר-מושב; ה-Analytics API הוא **Enterprise בלבד** (ב-Teams — ייצוא CSV). המכסה משותפת עם Claude chat ו-Cowork.

## תיקון 2 — עיצוב הקליטה שהצעתי היה שגוי בשני מקומות

**(א) התמלול המלא כבר בהישג יד — הבנייה קטנה ממה שאמרתי.**
אמרתי שנרכיב את הסשן מאירועי `PostToolUse`. מיותר: ה-hook מקבל **`transcript_path`** — נתיב לתמלול המלא — **והרפו שלך כבר קורא אותו** (`.claude/hooks/build-session-proposal.mjs:118`, `buildTranscript(hook.transcript_path)`). כלומר "לראות את כל הטקסט ולא רק תקציר" הוא **בחירה של ה-hook הקיים**, לא מגבלת פלטפורמה, ולא דורש צנרת חדשה.
בנוסף: אירועי `PostToolUse` נותנים קלט/פלט של כלים אבל **לא את הטקסט של Claude עצמו** — לכן התמלול הוא המקור הנכון, לא שחזור-מאירועים.

**(ב) אל תשלח ברשת על כל קריאת-כלי.** hooks רצים **בתוך** מהלך העבודה של Claude — POST סינכרוני בכל קריאת-כלי מוסיף השהיה לכל פעולה. הנכון: לכתוב מקומית ולשלוח **באצווה / אסינכרוני**, עם spool מקומי שלא מאבד אירועים כשה-backend למטה (אותו רעיון כמו `runs.jsonl` ב-video-lab).

**דיוק קטן:** `Stop` יורה בסוף **כל תור**, לא בסוף הסשן (נראה בעין בסשן הזה — ה-hook מזכיר בכל תור). להרצת headless חד-תורית זה שקול ל"העבודה נגמרה"; לסשן אינטראקטיבי צריך אירוע סיום-סשן.

## המלצה מעודכנת

1. **שלב 0 — החלטה מנהלית לפני קוד:** לבדוק Teams/Enterprise. אם עוברים, דרישות "צי-חשבונות", "שליטה מרכזית במשתנים" ו"נראות-שימוש" **יורדות מרשימת-הבנייה** ונפתרות טוב יותר. אל תבנה שכבת-סיבוב-טוקנים לפני ההחלטה הזו.
2. **שלב 1 — הבנייה האמיתית (קטנה):** להרחיב את ה-hook הקיים כך שישלח את **התמלול המלא** (לא רק תקציר) + מסך חיפוש. מנצל צנרת קיימת; זו התוספת בעלת יחס-ערך/מאמץ הטוב ביותר.
3. **שלב 2 — הפעלה מהאפליקציה:** עבודת-תמונות headless + התראת-סיום, עם שער-אישור-העלות (כלל 2) נשמר. זה הערך הדו-כיווני האמיתי.
4. **לדחות/לבטל:** אמידת-מכסה עצמית (מיותרת ב-Enterprise, מקורבת ב-Pro/Max) ושכבת-סיבוב-חשבונות.
5. **⚠️ נשאר בתוקף:** סיבוב חשבונות לעקיפת-מגבלות = סיכון ToS. המפעיל אישר שהמטרה היא **חשבונות למטרות נפרדות** — לגיטימי.

## מה **לא** נבדק (פתוח לבדיקה הבאה)

- האם אפשר לפתוח **סשן-ענן** (claude.ai/code) תוכניתית מהאפליקציה — יחסוך אירוח של headless על מכונה משלנו. `claude --cloud` קיים ב-CLI ודורש התחברות claude.ai (לא API key); הפעלה מתוך אפליקציה לא אומתה.
- עלות מדויקת פר-מושב ב-Teams/Enterprise (תמחור מסחרי — לברר מול Anthropic).

## סיכונים / פתוחים
- ToS על ריבוי-חשבונות-לעקיפה (לעיל) — הכי חשוב.
- אין פיד-יתרה תוכנתי → נראות-מגבלות תישאר משוערת.
- טוקן setup-token בלי Remote Control → הקונסולה תנהל סשני-headless, לא סשני-web מרוחקים.
