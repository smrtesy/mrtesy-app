# תהליך העיצוב הקבוע של smrtesy

> מקור-אמת אחד לכל עיצוב בפלטפורמה — ה-UI של המוצר, תוצרי-קלוד (דוחות, דפי
> Artifact, מצגות), וחומרי-שיווק. המטרה: כל תוצר יֵצא **ייחודי ומכוון**, ולא
> "יצעק AI/קלוד". נטען ונקרא בכל פעם שקלוד מעצב משהו.
>
> משותף לשלושת הריפו (`mrtesy-app`, `video-lab`, `voice-engine`). המסמך יושב
> כאן (ריפו-הפלטפורמה); השניים האחרים מפנים אליו. Verified: 2026-08-02.
>
> נבנה בשני סבבי-מחקר לפי פרוטוקול המחקר (סה"כ 32 מקורות; מקורות-סמכות רשמיים:
> Anthropic claude-cookbook + frontend-design plugin, W3C DTCG, Refactoring UI).
> המקורות בתחתית.

---

## 1. למה עיצוב-AI נראה תמיד אותו דבר (שורש הבעיה)

מודל שפה חוזה את הפלט **הכי שכיח** בנתוני-האימון — "distributional
convergence", התכנסות ל"מונוקולטורה אסתטית". שלושה גורמים מזינים אותה:

1. **דפוסי-אימון שכיחים** — רוב המדריכים השתמשו באותו כפתור (`indigo-500` של
   Tailwind) ובאותו gradient סגול ש"היה מודרני" ב-2015–2020.
2. **ספריית ברירת-מחדל** — כלי-ה-AI (Bolt/v0/Lovable/Cursor) בונים על
   `shadcn/ui` עם ההגדרות כמות-שהן: אותו `border-radius`, אותם אפורים
   נייטרליים, אותו `Inter`. התוצאה נקראת "shadcn aesthetic" — מוכשר ונשכח.
3. **חוסר-הכוונה** — בלי בריף, המודל חוזר לנקודת-ההתכנסות.

הביקורת הפכה מיינסטרים: "slop" נבחרה **מילת-השנה 2025** (Merriam-Webster),
עם פי-9 אזכורים. **המסקנה התפעולית:** ייחודיוּת היא **החלטה מפורשת שנלקחת
לפני שמעצבים**, ונאכפת בשער לפני שמפרסמים. או כפי שמנסחים את הפתרון ל-shadcn:
"ערוך 5 tokens והאפליקציה מפסיקה להיראות כמו כולם".

---

## 2. איך בוחרים כיוון — בלי להיות מעצב

זו הבעיה המרכזית של מי שאינו מעצב: "אני לא אדע להציע פונטים וצבעים". הפתרון
המקצועי הוא **לא לבקש מהלקוח לתאר** — אלא **להראות ולתת לבחור בעין**:

- **קלוד בוחר, לא אתה.** אומרים "עיצוב ייחודי, לא הגנרי" — וקלוד עושה את
  ההחלטות, מעוגן בנושא. אין צורך באוצר-מילים של מעצב.
- **גלריית-כיוונים לבחירה.** קלוד מייצר מספר **עולמות שלמים** על אותו תוכן
  אמיתי, והמשתמש מצביע על מספר. שיטת "אשליית-הבחירה": להציג קונספטים חלופיים
  מעביר את הלקוח מ"אני אוהב את זה?" ל"איזה אני מעדיף?" — החלטה קלה ובטוחה.
  (זהו בדיוק מה ש-shadcn Create עושה מ-2025: מתחילים מ-preset של אישיות,
  לא מגנרי.)
- **הבחירה הופכת ל"בריף הנעול"** (§9) — וממנו הכל נגזר. אפשר גם לשלב
  ("טיפוגרפיה של 1, צבעים של 6").

**מספר כיוונים מומלץ:** 4–6 לסבב ראשון (רוחב), ואז זיקוק ל-2–3.

---

## 3. השער האנטי-AI — רשימת האיסור

לפני שמפרסמים/מוסרים כל תוצר, עוברים על הרשימה. תוצר שעונה על אחד מאלה בלי
החלטה מודעת — נראה כמו AI וצריך לתקן:

**טיפוגרפיה**
- [ ] `Inter` / `Roboto` / `Arial` / `Open Sans` / `Lato` / `system-ui`
  כפונט-מותג. גם `Space Grotesk` — נשחק.
- [ ] הכל באותו משקל (400 מול 600), בלי קפיצות-משקל וגודל אמיתיות.

**צבע**
- [ ] gradient כחול↔סגול (במיוחד על לבן). CTA `#7C3AED` / `indigo-500`.
- [ ] פלטה "ביישנית" — צבעים רבים בעוצמה שווה, בלי דומיננטי ואקצנט חד.
- [ ] אפור-נייטרל **טהור** (מזוהה כ"לא-נבחר" — מותגים חזקים לעולם לא משתמשים בו).

**פריסה**
- [ ] hero ענק עם כותרת עמומה ("Build the future", "פתרונות שמניעים תוצאות").
- [ ] שלושה כרטיסים זהים עם `border-radius` אחיד (16px) על הכל — "shadcn look".
- [ ] ריווח "מושלם-מתמטית" קר; סימטריה מלאה; `frosted-glass`.
- [ ] אימוג'י כסמני-סעיף; מספור `01/02/03` שלא מקודד רצף אמיתי.

**רקע ותנועה**
- [ ] רקע צבע-אחיד שטוח בלי עומק.
- [ ] תנועות מפוזרות בכל מקום (זה עצמו מסמן "AI") — במקום רגע-אחד מתוזמן.

**תוכן**
- [ ] משפטי-מילוי גנריים ("פתרונות יוצאי-דופן שמניעים ערך אמיתי").

---

## 4. עקרונות הייחודיוּת — מה כן עושים

מבוסס על ההנחיה הרשמית של Anthropic (cookbook + frontend-design plugin),
Refactoring UI, ומקרי-מבחן של מותגים חזקים (Stripe/Linear/Vercel):

1. **טיפוגרפיה נושאת את האישיות** (פירוט ב-§5). פונט ייחודי אחד בהחלטיוּת,
   בניגוד גבוה. Vercel הזמינו פונט משלהם (Geist); Stripe — serif בהזמנה
   לכותרות. הפונט לבדו אומר "בנוי בקפידה" בלי מילה.
2. **ניגוד אגרסיבי.** שחור-על-לבן / לבן-על-שחור, בלי אמצע בוצי. העין יודעת מיד
   לאן ללכת. (עיקרון-בסיס ב-Refactoring UI: היררכיה דרך **גודל/משקל/צבע**.)
3. **צבע דומיננטי + אקצנט חד**, לא פלטה אחידה. צבע ל**משמעות**, לא לקישוט
   (אדום=סכנה, ירוק=הצלחה, מותג=פעולה ראשית).
4. **נייטרל נבחר — לעולם לא אפור טהור.** כל משטח נושא עקבה של גוון-המותג, כל
   צל נוטה לאותה טמפרטורה. זה ההבדל בין "יקר" ל"ברירת-מחדל".
5. **whitespace נדיב.** התחל מיותר-מדי אוויר והסר — לא להיפך (Refactoring UI:
   "grayscale-first, start with too much space").
6. **חתימה ויזואלית אחת.** אלמנט מזהה שחוזר (כמו "the Vercel grid"). אנרגיה
   אחת נועזת — והכל סביבה שקט.
7. **מיקרו-אינטראקציה מעוצבת.** מצבי-כפתור אמיתיים (ל-Linear יש 6 לכל כפתור),
   focus-ring מכוון — לא ברירת-מחדל של הספרייה.
8. **עיגון בנושא.** כל בחירה נגזרת מהעולם של הנושא הספציפי — לא תבנית לכל דבר.
9. **שני מצבי-תצוגה** (בהיר/כהה) באותה תשומת-לב — לא היפוך נאיבי.

---

## 5. טיפוגרפיה — כללים + עברית/RTL

### כללי
- **type scale נבחר-ביד**, קפיצה **≥1.25x** בין דרגות (פחות מזה לא נתפס).
  לתוצר נועז — קפיצות 3x+.
- **קיצוניות-משקל:** 100/200 מול 800/900 (לא 400 מול 600).
- **אורך-שורה** לקריאוּת: 50–75 תווים, מתוק ב-**66** (Bringhurst). `text-wrap:
  balance` לכותרות.
- כיווני-פתיחה ללועזית (נבחרים בבריף): Editorial — `Fraunces`/`Playfair
  Display`/`Newsreader`; Technical — `IBM Plex`; Code — `JetBrains Mono`;
  Distinctive — `Bricolage Grotesque`.

### עברית / RTL — קריטי אצלנו (רוב התוכן עברי)
- **פונט עברי איכותי, לא ברירת-מחדל.** אזהרה: פונטים גרועים הם "אותיות
  לטיניות בתחפושת עברית". איכותיים: `Heebo` / `Assistant` (workhorse),
  `Alef`, ל-serif `Frank-Ruhl`/`Bellefair`, ל-display `Suez One` /
  `Adapter Hebrew Display` (Rosetta) / `ABC Favorit Hebrew`. יצוקות עבריות:
  AlefAlefAlef, FontBit, Fontef.
- **עברית דורשת גודל וריווח-מילים גדולים יותר** — אבל **לא** `letter-spacing`
  (שובר את חיבור-האותיות).
- **RTL אינו "מראה מהופך".** נבדקים ניווט, כיווניות אלמנטים, זרימה, ומעורבות
  עברית-אנגלית-מספרים. פונט שלא תומך בעברית מציג "tofu" (ריבועים ריקים);
  לתוכן דתי/מנוקד — לוודא תמיכת niqqud.

---

## 6. צבע — איך בונים פלטה (גם בלי לדעת תורת-צבע)

- **OKLCH** הוא התקן (W3C DTCG, 10/2025): אחידות פרספטואלית — שינוי מספרי שווה
  = שינוי-בהירות נתפס שווה. HSL "שקרי" (dark stops יוצאים ירקרקים/חומים).
- **נגישות ב-OKLCH:** נועלים את `L` (בהירות) לטקסט וכווננים `C`/`h` כדי לעמוד
  ב-WCAG 2.2 — **4.5:1** לגוף-טקסט, **3:1** לטקסט-גדול/UI.
- **יחס 60-30-10:** 60% דומיננטי, 30% משני, 10% אקצנט.
- **נייטרל מוטה-גוון** לכיוון האקצנט (§4.4).

---

## 7. תנועה — ריסון, לא ראווה

- **מטרה מעל ראווה.** תנועה מכוונת את העין, לא מסנוורת. רגע-אחד מתוזמן היטב
  (page-load עם `animation-delay` מדורג) עדיף על עשר מיקרו-אנימציות.
- **משך:** תת-**300ms** (180ms נתפס רספונסיבי יותר מ-400). `easing` טבעי.
- **להסיר אנימציה** מפעולות בתדירות-גבוהה ומקיצורי-מקלדת. לכבד
  `prefers-reduced-motion`.

---

## 8. הכלים שיש לקלוד (מאומת בסשן)

| כלי | מה הוא | מתי |
|---|---|---|
| **`artifact-design` (סקיל)** | הנחיות-היסוד + פרק Process + רשימת ה-tells | לפני **כל** דף/תוצר מעוצב — נטען ראשון |
| **`Artifact` (כלי)** | פרסום דף HTML/MD מתארח, theme-aware, self-contained | דוחות, דפי-נחיתה, מצגות, כל תוצר-קלוד חזותי |
| **`DesignSync` (כלי) + `/design-sync`** | מערכת-עיצוב בענן `claude.ai/design` המסתנכרנת לספריית-רכיבים מקומית | **מקור-האמת** של ה-tokens והרכיבים |
| **`dataviz` (סקיל)** | פלטת-גרפים עקבית, נגישה, בהיר/כהה | כל תרשים/גרף/דשבורד |
| **`frontend-design` (plugin רשמי)** | סקיל-Anthropic נוסף לאסתטיקה מובחנת | חלופה/השלמה ל-artifact-design |

---

## 9. התהליך החוזר — כך זה עובד בכל פעם

### שלב 0 (חד-פעמי, בהקמה) — בריף-המותג
לפני שמעצבים כל דבר, קיים **בריף-כיוון** קצר שממנו הכל נגזר — זה המנגנון
שמונע חזרה לברירת-המחדל. מקורו: המשתמש בוחר כיוון מגלריית-הכיוונים (§2).
הבריף קובע פעם אחת:

- **פונטים:** display + body + utility (עברי איכותי, §5).
- **צבע:** דומיננטי + אקצנט + הטיית-נייטרל (60-30-10, §6).
- **עמדת-פריסה:** עריכותי / טכני / מינימלי + רמת-מורכבות תואמת.
- **חתימה ותנועה:** האלמנט המזהה + איפה הרגע-האחד.

הבריף חי כ**מערכת-עיצוב אחת ב-`claude.ai/design`** (פרויקט design-system) עם
ה-tokens (§10) והרכיבים. זו נקודת-ההקמה היחידה שדורשת אישור המשתמש.

### שלבים 1–4 (בכל עיצוב)
1. **טען `artifact-design`** ומשוך את ה-tokens ממערכת-העיצוב (`DesignSync`:
   `list_files`/`get_file`).
2. **עצב מול ה-tokens** — לא צבעים/פונטים קשיחים. עגן בנושא.
3. **עבור את שער §3** לפני פרסום/commit. נופל בשער — מתקנים, לא מפרסמים.
4. **רכיב חדש חוזר?** סנכרן חזרה למערכת-העיצוב (`DesignSync`:
   `finalize_plan`→`write_files`, כרטיס `@dsCard`) — כדי שהתוצר הבא ימשוך ממנו.

---

## 10. ארכיטקטורת ה-tokens (תקן W3C DTCG 2025.10)

שלוש שכבות, **זרימת-תלות חד-כיוונית קשיחה** (חוצה-שכבות אסור):

| שכבה | מה | דוגמה |
|---|---|---|
| **Primitive** | ערכים גולמיים, בלי משמעות | `--ds-color-indigo-500`, `--ds-space-16` |
| **Semantic** | משמעות ותפקיד; כאן חי ה-theming | `--ds-color-action-primary`, `--ds-space-stack-lg` |
| **Component** | ממודר לרכיב | `--ds-button-bg-hover` |

- **Theming = החלפת ערכי שכבת ה-semantic בלבד** — ה-primitives קבועים. כך
  עוברים בהיר↔כהה, או מותג↔מותג, בלי לגעת ברכיבים.
- **Component tokens רק כשצריך** (מולטי-מותג/white-label) — הם מכפילים את
  המספר (200 semantic → 2000+). Naming: `kebab-case` עם namespace `--ds-…`.

---

## 11. גבולות המסמך

המסמך קובע **תהליך וכללים**, לא זהות ספציפית. בחירת הפונטים/הצבעים הסופיים של
smrtesy, הלוגו, רישוי-פונטים וקוד-מימוש — נגזרים בבריף (§9) בהחלטת המשתמש בעין
מגלריית-הכיוונים, לא כאן.

---

## מקורות (32; עיקריים)

**סמכות רשמית**
- Anthropic — *Prompting for frontend aesthetics* (cookbook): https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics
- Anthropic — *Improving frontend design through Skills* + `frontend-design` SKILL.md: https://claude.com/blog/improving-frontend-design-through-skills · https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md
- סקיל `artifact-design` (פנימי) + סכמת `DesignSync` / `/design-sync`
- W3C DTCG design tokens 2025.10: https://tasteprofile.io/blog/w3c-dtcg-design-tokens-practical-guide
- Refactoring UI (סיכום): https://howtoes.blog/2025/07/04/refactoring-ui-complete-book-summary-all-key-ideas/

**עברית / RTL**
- Daniel Rosehill — Hebrew fonts: https://blog.danielrosehill.com/posts/hebrew-fonts-worth-knowing
- DTP Labs — RTL typography: https://www.dtplabs.com/blog/rtl-typography-complete-guide-arabic-hebrew-farsi
- AlefAlefAlef — Israeli font designers: https://alefalefalef.co.il/en/israeli-font-designers3/
- Adapter Hebrew Display (Rosetta): https://fonts.adobe.com/fonts/adapter-hebrew-display
- RTL pitfalls: https://d-fsl.org/blog/mastering-rtl-website-design-common-pitfalls-and-best-practices-for-success/

**תווי-AI ומגמה**
- 925studios — AI Slop: https://www.925studios.co/blog/ai-slop-web-design-guide
- Why all websites look the same (shadcn/convergence): https://www.bhuwan-garbuja.com/blog/why-all-websites-look-the-same/
- The shadcn trap: https://freedesignmd.com/blog/shadcn-looks-generic
- Jack Pearce — purple gradient: https://www.jackpearce.co.uk/notes/purple-gradient-ai-aesthetics/
- slop = Word of Year 2025: https://euronews.com/next/2025/12/28/2025-was-the-year-ai-slop-went-mainstream-is-the-internet-ready-to-grow-up-now

**מקרי-מבחן, צבע, תנועה, tokens, בחירת-כיוון**
- Stripe/Linear/Vercel premium UI: https://mantlr.com/blog/stripe-linear-vercel-premium-ui
- 4 עקרונות: https://www.pixeldarts.com/en/post/four-design-principles-behind-stripe-linear-and-vercel
- Vercel grid: https://www.setproduct.com/blog/complete-guide-to-blueprint-grid-design
- OKLCH/WCAG: https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes · https://canonical.design/blog/generating-color-palettes-for-design-systems-inspired-by-apca
- Motion best practices: https://gapsystudio.com/blog/ui-animation-best-practices/
- Multi-brand theming (Style Dictionary): https://www.alwaystwisted.com/articles/a-design-tokens-workflow-part-9
- 'Illusion of Choice' (הצגת קונספטים): https://rachelhurry.gumroad.com/l/creative-direction-proposal
- shadcn Create presets: https://blog.logrocket.com/shadcn-ui-adoption-guide/
- אורך-שורה (Bringhurst): https://www.uxpin.com/studio/blog/optimal-line-length-for-readability/
- broken/asymmetric grid: https://blog.hubspot.com/website/broken-grid-layouts
- brand voice/tone: https://www.uxdesigninstitute.com/blog/tone-of-voice-for-ux-writing/
