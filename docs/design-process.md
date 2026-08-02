# תהליך העיצוב הקבוע של smrtesy

> מקור-אמת אחד לכל עיצוב בפלטפורמה — ה-UI של המוצר, תוצרי-קלוד (דוחות, דפי
> Artifact, מצגות), וחומרי-שיווק. המטרה: כל תוצר יֵצא **ייחודי ומכוון**, ולא
> "יצעק AI/קלוד". נטען ונקרא בכל פעם שקלוד מעצב משהו.
>
> משותף לשלושת הריפו (`mrtesy-app`, `video-lab`, `voice-engine`). המסמך יושב
> כאן (ריפו-הפלטפורמה); השניים האחרים מפנים אליו. Verified: 2026-08-02.
>
> נבנה ממחקר לפי פרוטוקול המחקר (11 מקורות; מקור-סמכות רשמי: Anthropic
> claude-cookbook). המקורות בתחתית.

---

## 1. למה עיצוב-AI נראה תמיד אותו דבר (שורש הבעיה)

מודל שפה חוזה את הפלט **הכי שכיח** בנתוני-האימון. בעיצוב-פרונט זה מתכנס תמיד
לאותה נקודה ("distributional convergence" / "aesthetic monoculture"): רוב
המדריכים והדוגמאות באינטרנט השתמשו באותם פונטים ובאותו כפתור — למשל
`indigo-500` שהיה ברירת-המחדל של Tailwind, ו-gradient סגול שהיה "מודרני"
ב-2015–2020. לכן בלי הכוונה מפורשת, קלוד (וכל מודל) שב לשם.

**המסקנה התפעולית:** ייחודיוּת היא לא "מזל" — היא **החלטה מפורשת שנלקחת לפני
שמעצבים**, ונאכפת בשער לפני שמפרסמים. שני חלקים: (א) מה **אסור** (הימנעות
מהברירות-מחדל), (ב) מה **כן** (הכוונה חיובית + מקור-אמת חוזר).

---

## 2. השער האנטי-AI — רשימת האיסור

לפני שמפרסמים/מוסרים כל תוצר, עוברים על הרשימה. אם תוצר עונה על אחד מאלה בלי
החלטה מודעת — הוא נראה כמו AI וצריך לתקן:

**טיפוגרפיה**
- [ ] פונט `Inter` / `Roboto` / `Arial` / `Open Sans` / `Lato` / `system-ui`
  כפונט-המותג. גם `Space Grotesk` — נשחק לגמרי.
- [ ] כל הטקסט באותו משקל (400 מול 600), בלי קפיצות-משקל וגודל אמיתיות.

**צבע**
- [ ] gradient כחול↔סגול (במיוחד על רקע לבן). ה-CTA `#7C3AED` / `indigo-500`.
- [ ] פלטה "ביישנית" — הרבה צבעים בעוצמה שווה, בלי צבע דומיננטי ואקצנט חד.
- [ ] אפור-נייטרל טהור (מזוהה כ"לא-נבחר").

**פריסה**
- [ ] hero ענק עם כותרת עמומה ("Build the future", "פתרונות שמניעים תוצאות").
- [ ] שלושה כרטיסים זהים עם `border-radius` אחיד (16px) על הכל.
- [ ] ריווח "מושלם-מתמטית" וקר; סימטריה מלאה; `frosted-glass` על כרטיסים.
- [ ] אימוג'י כסמני-סעיף; מספור `01/02/03` שלא מקודד רצף אמיתי.

**רקע ותנועה**
- [ ] רקע צבע-אחיד שטוח בלי עומק.
- [ ] תנועות מפוזרות בכל מקום (זה עצמו מסמן "AI") — במקום רגע-אחד מתוזמן.

**תוכן**
- [ ] משפטי-מילוי גנריים ("פתרונות יוצאי-דופן שמניעים ערך אמיתי").

---

## 3. עקרונות הייחודיוּת — מה כן עושים

מבוסס על ההנחיה הרשמית של Anthropic (claude-cookbook) + עיצוב עריכותי:

1. **טיפוגרפיה נושאת את האישיות.** בוחרים פונט-display ייחודי בהחלטיוּת, לא
   כמה גנריים. כיווני-פתיחה (לא נעילה — נבחר בבריף, §5): Editorial —
   `Playfair Display` / `Fraunces` / `Newsreader`; Startup — `Clash Display`
   / `Satoshi` / `Cabinet Grotesk`; Technical — משפחת `IBM Plex`; Distinctive
   — `Bricolage Grotesque`. **זיווג בניגוד גבוה** (display+mono, או
   serif+geometric-sans).
2. **ניגוד קיצוני, לא ביניים.** משקלים 100/200 מול 800/900 (לא 400 מול 600).
   קפיצות-גודל 3x+ (לא 1.5x).
3. **צבע דומיננטי + אקצנט חד.** מחייבים אסתטיקה אחת קוהרנטית דרך CSS variables.
   השראה מ-IDE themes / אסתטיקות-תרבות — לא מפלטה "בטוחה". צבע-סמנטי
   (טוב/אזהרה/קריטי) נפרד מצבע-האקצנט.
4. **נייטרל נבחר, לא ברירת-מחדל.** אפור עם הטיית-גוון קלה לכיוון האקצנט נקרא
   כ"נבחר".
5. **עומק ברקע.** שכבות gradient / דפוסים גאומטריים / אפקט-הקשרי — לא צבע שטוח.
6. **תנועה בריכוז.** רגע-אחד מתוזמן היטב (page-load עם `animation-delay`
   מדורג) עדיף על עשר מיקרו-אנימציות. לכבד `prefers-reduced-motion`.
7. **עיגון בנושא.** כל החלטה (צבע/פונט/פריסה) נגזרת מהעולם של הנושא הספציפי —
   לא תבנית שמתאימה לכל דבר. "מבנה מקודד מידע אמיתי" (מספור רק לרצף אמיתי).
8. **שני מצבי-תצוגה.** בהיר וכהה מקבלים אותה תשומת-לב (רמת-tokens, לא היפוך
   נאיבי) — אלא אם התוצר מחויב בכוונה לעולם-חזותי אחד.

---

## 4. הכלים שיש לקלוד (מאומת בסשן)

| כלי | מה הוא | מתי |
|---|---|---|
| **`artifact-design` (סקיל)** | הנחיות-היסוד + פרק Process + רשימת ה-tells | לפני **כל** דף/תוצר מעוצב — נטען ראשון |
| **`Artifact` (כלי)** | פרסום דף HTML/MD מתארח, theme-aware, self-contained | דוחות, דפי-נחיתה, מצגות, כל תוצר-קלוד חזותי |
| **`DesignSync` (כלי) + `/design-sync`** | מערכת-עיצוב בענן `claude.ai/design` המסתנכרנת לספריית-רכיבים מקומית (רכיב-אחר-רכיב) | **מקור-האמת** של ה-tokens והרכיבים |
| **`dataviz` (סקיל)** | פלטת-גרפים עקבית, נגישה, בהיר/כהה | כל תרשים/גרף/דשבורד |

---

## 5. התהליך החוזר — כך זה עובד בכל פעם

### שלב 0 (חד-פעמי, בהקמה) — בריף-המותג
לפני שמעצבים כל דבר, קיים **בריף-כיוון** קצר שממנו הכל נגזר. זהו המנגנון
שמונע חזרה לברירת-המחדל. הבריף קובע פעם אחת:

- **פונטים:** display + body + utility (מ-§3, לא מ-§2).
- **צבע:** צבע דומיננטי אחד + אקצנט חד + הטיית-הנייטרל.
- **עמדת-פריסה:** עריכותי / טכני / מינימלי — ורמת-המורכבות התואמת.
- **עמדת-תנועה:** איפה הרגע-האחד המתוזמן.

הבריף חי כ**מערכת-עיצוב אחת ב-`claude.ai/design`** (פרויקט מסוג
design-system), עם ה-tokens (§6) והרכיבים. זו נקודת-ההקמה היחידה שדורשת
אישור המשתמש (יצירת הפרויקט + חיבור claude.ai).

### שלבים 1–4 (בכל עיצוב)
1. **טען `artifact-design`** ומשוך את ה-tokens ממערכת-העיצוב (דרך
   `DesignSync` — `list_files`/`get_file`).
2. **עצב מול ה-tokens** — לא מ-hardcoded צבעים/פונטים. עגן בנושא.
3. **עבור את שער §2** לפני פרסום/commit. תוצר שנופל בשער — מתקנים, לא מפרסמים.
4. **רכיב חדש חוזר?** סנכרן אותו חזרה למערכת-העיצוב (`DesignSync`:
   `finalize_plan`→`write_files`, כרטיס `@dsCard`) כדי שהתוצר הבא ימשוך ממנו.
   כך המערכת מתעשרת ונשארת מקור-אמת אחד.

---

## 6. ארכיטקטורת ה-tokens (תקן W3C DTCG 2025.10)

שלוש שכבות, **זרימת-תלות חד-כיוונית קשיחה** (primitive → semantic →
component; חוצה-שכבות אסור — יוצר תלות מעגלית):

| שכבה | מה | דוגמה |
|---|---|---|
| **Primitive** | ערכים גולמיים, בלי משמעות | `--ds-color-indigo-500`, `--ds-space-16` |
| **Semantic** | משמעות ותפקיד; כאן חי ה-theming | `--ds-color-action-primary`, `--ds-space-stack-lg` |
| **Component** | ממודר לרכיב | `--ds-button-bg-hover` |

Naming: `kebab-case` עקבי עם namespace (`--ds-...`). Theming (בהיר/כהה) =
החלפת שכבת ה-semantic בלבד — הרכיבים לא נוגעים ב-primitives ישירות.

---

## 7. גבולות המסמך

המסמך קובע **תהליך וכללים**, לא זהות ספציפית. בחירת הפונטים/הצבעים הסופיים
של smrtesy, הלוגו, רישוי-פונטים וקוד-מימוש — נגזרים בבריף (§5) בהחלטת המשתמש,
לא כאן.

---

## מקורות

- Anthropic — *Prompting for frontend aesthetics* (claude-cookbook, רשמי):
  https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics
- סקיל `artifact-design` (פנימי, Anthropic) — רשימת ה-tells + פרק Process
- סכמת `DesignSync` + סקיל `/design-sync` — workflow מערכת-העיצוב
- W3C DTCG design tokens 2025.10:
  https://tasteprofile.io/blog/w3c-dtcg-design-tokens-practical-guide
- 925studios — *AI Slop Web Design*: https://www.925studios.co/blog/ai-slop-web-design-guide
- UX Planet (N. Babich) — *How to spot AI-generated design*:
  https://uxplanet.org/how-to-spot-ai-generated-design-697aaabe76c8
- Jack Pearce — *Where does that purple gradient come from*:
  https://www.jackpearce.co.uk/notes/purple-gradient-ai-aesthetics/
- *Why your AI keeps building the same purple gradient website*:
  https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website
- Subframe — *Editorial website design*: https://www.subframe.com/tips/editorial-website-design-examples
- TechRadar — *Websites becoming more similar, research finds*:
  https://www.techradar.com/news/websites-becoming-more-and-more-similar-research-finds
- DEV — *Break the AI-generated UI curse*:
  https://dev.to/a_shokn/how-to-break-the-ai-generated-ui-curse-your-guide-to-authentic-professional-design-2en
