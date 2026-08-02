# smrtDesign — תוכנית-בנייה (v1)

> אפליקציית-פלטפורמה חדשה ב-smrtesy: מחולל רעיונות-עיצוב שרץ על **הקלוד-המובנה**,
> מונחה ע"י שיטת-העיצוב שבנינו (`docs/design-process.md`), מציג את האפשרויות
> בגלריה נוחה, מאפשר **לבחור מה לקחת מאיפה**, ומציג עיצוב-משולב מעודכן.
> דו-לשוני (עברית+אנגלית). Slug: `smrtdesign` · שם-תצוגה: `smrtDesign`.
>
> **סטטוס: טיוטה לאישור.** לא נבנה עד "כן". תיארוך: 2026-08-02.

---

## 1. מה זה, בקצרה

מסך `/design` שבו:
1. אתה מתאר **נושא** (למשל "דף שער ל-ai chochom, עברית+אנגלית").
2. smrtDesign מריץ את **השיטה** (§0 של `design-process.md`) דרך הקלוד-המובנה —
   מוצא עוגנים, גוזר עיצובים, ומרנדר **N אפשרויות** לתמונות.
3. האפשרויות מוצגות ב**גלריה** נוחה (בדיוק כמו שראית בשיחה, אבל בתוך המוצר).
4. אתה **בוחר מה לקחת מאיפה** — טיפוגרפיה מ-1, צבע מ-3, עימוד מ-2 — והקלוד
   מרכיב **עיצוב-משולב מעודכן** ומרנדר אותו.
5. הכל נשמר לפרויקט (אפשר לחזור, לזקק, לייצא).

## 2. ההחלטה הארכיטקטונית המרכזית — לרכב על הקלוד-המובנה

**לא בונים מנוע-AI חדש.** הקלוד-המובנה (`/claude`, `server/src/modules/claude/`)
כבר נותן את כל מה שצריך, בעלות אפס (מנוי, לא API):
- מריץ Claude Code אמיתי עם **גישת-רפו** → קורא את `docs/design-process.md`
  אוטומטית (ה-CLAUDE.md + codebase-map נטענים בכל thread-רפו).
- **מרנדר ומצלם** דרך ה-browser-helper (Chromium מובנה) ומחזיר תמונות inline —
  זו בדיוק לולאת האימות-בעיניים (§0 בשיטה).
- Threads, playbooks, standing-instructions, ובלוקים-אינטראקטיביים כבר קיימים.

smrtDesign = **שכבת-מוצר דקה** מעל המנוע הזה: playbook ייעודי + סכימת-נתונים
לפרויקטים/אפשרויות/בחירות + UI של גלריה ובורר-רמיקס.

## 3. זרימת-המשתמש (v1)

1. **פרויקט חדש** → טופס קצר: נושא, קהל, שפות, וכמה אפשרויות (ברירת-מחדל 4).
2. **הרצה** → smrtDesign פותח thread בקלוד-המובנה עם ה-**smrtDesign playbook**
   (שמצמיד את השיטה): "הרץ את §0 על הנושא הבא, N עוגנים שונים, רנדר כל אחד,
   החזר תמונה + spec-JSON לכל אפשרות".
3. **גלריה** → כרטיס לכל אפשרות: תמונה + שם-העוגן + ה-spec (פונטים/צבע/עימוד/
   חתימה) + כפתור "בחר".
4. **רמיקס (v2, ראה §6)** → בורר לפי-רכיב: לכל ממד (טיפוגרפיה/צבע/עימוד/תנועה/
   חתימה) בוחרים מאיזו אפשרות לקחת → "הרכב" → הקלוד מרכיב ומרנדר משולב.
5. **נעילה** → האפשרות/המשולב הנבחר נשמר כ"בריף נעול" של הפרויקט (מזין §9 בשיטה).

## 4. מנגנון "קח מכל אחד" (הליבה הייחודית)

כל אפשרות מוחזרת מהקלוד לא רק כתמונה אלא כ**spec-JSON מובנה** לפי 7 ממדי-השילוב
(§4 בשיטה): `{ anchor, typography, color, neutral, layout, motion, signature,
voice }`. הרמיקס פשוט: המשתמש בוחר לכל ממד מאיזו אפשרות-מקור לקחת; smrtDesign
בונה spec-משולב ומעביר לקלוד "רנדר את ה-spec הזה" (אותה שיטה, קלט מפורש). כך
ה"שילוב" אמין ולא ניחוש — וגם עובר את **מבחן-ההתבדלות** (§0 צעד 6) לפני שמוצג.

## 5. מה נבנה (לפי `docs/new-app-guide.md`, תבנית smrtVoice)

**DB** (`smrtdesign_`-prefix, `org_id` + RLS, שתי מיגרציות):
- `INSERT INTO apps ('smrtdesign','smrtDesign', …)`.
- `smrtdesign_projects` — נושא, קהל, שפות, `brief_json`, סטטוס.
- `smrtdesign_options` — `project_id`, `anchor`, `spec_json`, `image_attachment_id`,
  `round`, `is_locked`.
- `smrtdesign_selections` — `project_id`, `picks_json` (ממד→option_id),
  `combined_option_id`.

**Server** (`server/src/modules/smrtdesign/`): `routes.ts` (projects/options CRUD,
`POST /design/projects/:id/generate`, `POST /design/projects/:id/remix`), `index.ts`;
כל ראוט `requireAuth+requireOrg+requireApp("smrtdesign")`. הגנרציה/רמיקס
**מפעילים את מנוע-הקלוד** (אותו runner של `/claude`, עם ה-smrtDesign playbook) —
אפס API בתשלום. Manifest ב-`server/src/apps/smrtdesign/manifest.ts`
(`emits: ["design.generated","design.locked"]`), נרשם ב-`APP_REGISTRY`.

**Frontend**: route group `(smrtdesign)/design` + `design/guide`; רכיבים ב-
`components/smrtdesign/` (`NewProjectForm`, `OptionsGallery`, `OptionCard`,
`RemixPicker`, `CombinedView`); אייקון `SmrtDesignIcon`; רישום ב-
`src/lib/apps/registry.ts` (`word:"Design"`, צבע ייעודי); סקשן ב-Sidebar
(`hasSmrtDesign`); i18n namespace `"smrtDesign"` בשני קבצי-השפה; דף-guide עם
`AppGuideLayout`.

**Playbook + שיטה**: הזרקת `docs/design-process.md` כמתודה — דרך smrtDesign
playbook ב-`claude_playbooks` (או standing-instruction) שאומר "קרא
`docs/design-process.md` והרץ את §0". **מקור-האמת של השיטה נשאר קובץ-הרפו** —
smrtDesign רק מפנה אליו, לא משכפל.

**מפת-הקוד + סטטוס**: עדכון `docs/codebase-map.md` באותו קומיט (map-guard אוכף),
ו-`PATCH /api/admin/apps/smrtdesign/status`.

## 6. שלבים

- **v1 (הליבה):** אפליקציה רשומה + פרויקט + הרצה שמחזירה N אפשרויות מרונדרות +
  גלריה + בחירת-אפשרות-שלמה + נעילה. **בלי** רמיקס לפי-רכיב.
- **v2 (הרמיקס):** בורר לפי-ממד + הרכבת spec-משולב + רינדור-משולב (§4).
- **v3 (עידון + נכסים):** סבבי-זיקוק ("תעשה את 2 יותר נועז"), ייצוא (HTML/tokens),
  חיבור ה-design-system (§10) כמקור-אמת חי; **מחוללי-נכסים דרך fal**
  (Recraft/Ideogram/Flux) ללוגו/איור/רקע בתוך עיצוב נבחר; ו**ייצוא/עריכה ב-Canva**
  (Design API) כנוחות-פלט. (ראה §9.)

## 7. עלות

**אפס API בתשלום.** הגנרציה/רינדור רצים על מנוע-הקלוד-המובנה
(`CLAUDE_CODE_OAUTH_TOKEN` — מנוי) ועל Chromium המובנה. אין קריאת-מודל בתשלום.
(אם בעתיד נרצה מודל-תמונה ללוגו — Recraft/Ideogram דרך fal — זו הרחבה נפרדת עם
אישור-עלות.)

## 8. מה צריך ממך

1. **אישור התוכנית** ("כן, בנה v1") — ואז אני בונה לפי הצ'קליסט של new-app-guide,
   עם pre-push מלא (build, greps, סוכן-ביקורת), ודוחף.
2. **הפעלה לארגון** — אחרי הבנייה, להדליק את smrtDesign לארגון שלך
   (Platform → Organizations → Apps), או שאעשה זאת במיגרציית-seed.
3. החלטה קטנה: **צבע-האפליקציה** בסיידבר (אבחר ברירת-מחדל אם לא אכפת לך).

---

## 9. חלופות שנשקלו — למה מנוע-הקלוד ולא כלי-חוץ

בדקנו (2026) אם כלי-חוץ מייצר "טקסט → רעיונות-עיצוב ייחודיים" דרך API:

- **ממלאי-תבניות (Canva Magic Design, Microsoft Designer, Adobe Express):** ה-AI
  הגנרטיבי **לא נגיש ב-API** (רק בעורך); מה שכן ב-API הוא **מילוי התבניות שלך**
  בנתונים → מראה **גנרי מעצם הבנייה**. ההיפך ממטרת-הייחוד. Canva שווה בעתיד רק
  כ**ייצוא/עריכה** (Design API), לא כמנוע.
- **מחוללי טקסט→UI (Vercel v0, Google Stitch, Uizard, Lovable, Bolt):** קיימים,
  יש API/MCP (ל-Stitch אף MCP ל-Claude Code) — אבל **כולם מתכנסים ל-shadcn/
  Tailwind הגנרי**. מקור מפורש: "הגנריות היא פיצ'ר, לא באג" (הפשרה שלהם לטובת
  מהירות ועקביות). הם פותרים מהירות, **לא ייחוד**. אקדח-מעשן: v0 עצמו רץ על מודל
  של Anthropic — אבל **כבול ל-shadcn**, ולכן גנרי. אנחנו משתמשים באותו סוג-מנוע,
  **משחררים את הכבל ומוסיפים עוגן (§0)** → ייחוד. לכן לא כמנוע.
- **מחוללי-נכסים (Recraft, Ideogram, Flux, Adobe Firefly):** API מצוין — אבל
  ל**נכסים** (לוגו/וקטור/איור/רקע), לא לפריסה שלמה. **כן שווים כתת-מחוללים**
  בתוך smrtDesign (ויש לנו כבר גישת **fal** — Recraft/Ideogram/Flux). → v3.

**מסקנה:** הדרך היחידה שמייצרת **פריסה ייחודית** מטקסט, תכנותית, היא **LLM
מונחה-שיטה שמרנדר לקוד** — בדיוק smrtDesign על הקלוד-המובנה. כלי-החוץ נכנסים
כ**תת-מחוללי-נכסים** (fal) וכ**ייצוא** (Canva), לא כמנוע.

מקורות: [Canva Connect](https://www.canva.dev/docs/connect/) · [v0](https://www.mindstudio.ai/blog/what-is-vercel-v0) · [Google Stitch (MCP+API)](https://www.abhs.in/blog/google-stitch-ai-ui-design-tool-developers-2026) · [shadcn = גנרי-בכוונה](https://rahuldotbiz.medium.com/i-tested-37-v0-alternatives-so-you-dont-have-to-2026-693e833f2c43) · [Recraft/וקטור-API](https://flowith.io/blog/10-best-recraft-alternatives-vector-brand-asset-2026/)

---

## 10. v2 — מודל-האינטראקציה: שיחה אינטראקטיבית + מסך-הכרעה (החלטת המשתמש, 2026-08-02)

**הבעיה ב-v1:** "עיצוב חדש" ירה הרצה **עיוורת** ברקע — טופס → N אפשרויות, בלי
דרך להגדיר/לכוונן תוך כדי שיחה. המשתמש רוצה אחרת: **smrtDesign = מסך-הכרעה,
והעבודה עצמה קורית בקלוד-המובנה האינטראקטיבי.** ההחלטה: **ב׳ ראשי + א׳ תוספת.**

### ב׳ (ראשי) — "עיצוב חדש" פותח שיחת-קלוד אמיתית
1. יצירת פרויקט פותחת **שיחת-קלוד-מובנה נראית** (`claude_threads`, לא-archived),
   עם `repo=smrtesy/mrtesy-app` (כך ששיטת-העיצוב נטענת).
2. השרת מפרסם **תור-פתיחה** לשיחה: השיטה (§0) + הבריף מהפרויקט + ה-callback
   (POST כל ציור ל-`/design/projects/:id/options`) + הנחיה: **"חדד את הבריף עם
   המשתמש קודם (שאלות/בלוק-Ask אינטראקטיבי), ורק כשהבריף ברור או שהמשתמש אומר
   'קדימה' — צייר."** הקלוד פותח בברכה+שאלות, לא בציור עיוור.
3. הפרונט מנווט את המשתמש ל-`/claude?thread=<id>` (הקונסולה תומכת deep-link
   ל-thread; מאומת ב-`ClaudeChat.tsx:249`). שם מנהלים שיחה, מכווננים, ומבקשים
   ציורים; **כל ציור נוחת מיד בגלריה של smrtDesign** דרך ה-callback.
4. `/design` נשאר **מסך-ההכרעה**: גלריה + בחירה-מכל-אחד + נעילה.

### א׳ (תוספת) — קשר שיחה קיימת לפרויקט
כפתור "קשר שיחה קיימת" → בוחר thread קיים → `POST /design/projects/:id/link-thread`
מקשר את ה-thread לפרויקט ומפרסם בו תור שמזריק את ה-callback, כך שכל ציור עתידי
באותה שיחה נוחת בגלריה.

### שינויים קונקרטיים
- **מיגרציה (אדיטיבית):** `smrtdesign_projects.mode text default 'conversation'`
  (`'conversation'` = שיחה אינטראקטיבית; `'auto'` = ההרצה-העיוורת של v1, נשמרת
  ככפתור-משני "ייצר אוטומטית"). ה-poll ב-GET מסתעף לפי `mode`: ב-`auto` —
  הלוגיקה הקיימת (flip ל-failed/options_ready לפי ההרצה); ב-`conversation` —
  לא נופלים ל-failed מתור בודד שנגמר (שיחה נמשכת), רק אוספים ציורים.
- **backend:** `ensureProjectThread` מקבל `visible` (archived מול נראה);
  `POST /design/projects/:id/open` (conversation) ו-`/link-thread` (א׳);
  `/generate` נשאר (auto).
- **frontend `DesignConsole`:** CTA ראשי "פתח שיחת עיצוב" → `/open` → `/claude?thread=`;
  משני "ייצר אוטומטית"; "קשר שיחה קיימת"; גלריה/רמיקס/נעילה כמו שהם.
- **גישה:** הקונסולה `/claude` דורשת super-admin; הבעלים (chanoch770) הוא
  super-admin, אז הזרימה עובדת לו. הרחבה למשתמשי-org לא-אדמין = עתידי (embed).

התיקון הראשון (2026-08-02, כבר ב-main): הרצת-repo חייבת thread — כל פרויקט
מקבל thread קבוע והרצות רצות כ-turns בתוכו.
