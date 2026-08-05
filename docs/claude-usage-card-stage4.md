# שלב 4 — כרטיס מד-שימוש בתיבת הכתיבה של קונסולת קלוד

מסמך המשך לסשן חדש. המטרה: להוסיף **כרטיס מד-שימוש** (אייקון עיגול
מתמלא + פירוט בלחיצה) בתיבת הכתיבה של הקונסולה, ליד בוררי המודל והעוצמה —
כמו הפופאובר "Your usage limits" ב-claude.ai.

## הקשר — מה כבר נבנה ופרוס (אל תבנה מחדש)

הבעיה שנפתרת: מגבלת הטוקנים של המנוי (חלון 5 שעות + שבועי) הגיעה בהפתעה.
הכלים בתוך smrtesy רצים על חשבונות-אוטומציה (`CLAUDE_CODE_OAUTH_TOKEN_<ID>`,
למשל ai3/ai4) והמגבלה משותפת לכל השימוש באותו חשבון-אנתרופיק. אין פיד
תוכניתי ליתרה אמיתית ב-Team (Analytics API הוא Enterprise-only), אז המערכת
**מעריכה** צריכה מ-`claude_runs.total_cost_usd` (עלות-API-שקולה) מול תקרה
מכוילת.

**כבר חי ב-main (commit `a76d4da` + `ec2b389`):**

| רכיב | מיקום | מצב |
|---|---|---|
| טבלת תקרות `claude_usage_limits` | migration `20260804200000` | ✅ |
| פונקציית אומדן `check_claude_usage_limits(p_dry_run bool)` | אותה migration | ✅ |
| cron כל 15 דק' → התראות 70%/90% ל-super-admins | job `claude-usage-limit-monitor` | ✅ פעיל |
| תיקון מונה-הטוקנים שקפא אחרי התור הראשון | `ClaudeChat.tsx` `tickLive` | ✅ פרוס |

**מפתחי הפונקציה** (זה מה שה-endpoint של שלב 4 קורא):
`check_claude_usage_limits(true)` מחזירה `TABLE(claude_account text,
window_start timestamptz, window_end timestamptz, cost_used numeric,
cap_cost numeric, pct int, threshold_crossed int, alerted bool)` — שורה
אחת לכל חשבון פעיל עם חלון 5h פעיל. `p_dry_run=true` = קריאה בלבד, לא
שולחת התראות.

**כיול נוכחי ב-DB** (טבלת `claude_usage_limits`, `window_kind='session'`):
`'*'`=$18 (ברירת-מחדל שמרנית), `ai3`=$53, `ai4`=$53. weekly: `'*'`=$200
(placeholder — אין עדיין אירוע-מיצוי שבועי לכיול). **המדד הוא
`total_cost_usd`** — עלות-API-שקולה, פרוקסי, לא נתון-אמת מאנתרופיק.

## מצב — הושלם (2026-08-05)

כל שלב 4 נבנה ונדחף: endpoint `GET /claude/account-usage` (`routes.ts`), רכיב
`UsageMeter.tsx`, חיווט ב-`ChatComposer`/`ClaudeChat`, ומפתחות `claudeChat.meter`
בשני קבצי ההודעות. שני חידודים מעבר לספק המקורי: (1) המד השבועי מחזיר `pct=null`
עד שקיים אירוע-מיצוי שבועי אמיתי (`claude_usage_hits kind='weekly'`) — התקרה
`$200` היא placeholder, ואחוז מולה היה נקרא כמדידה אמיתית; (2) הכיול האוטומטי
(שנבנה יחד, לפי ההמלצה למטה) רץ רק ב-`p_dry_run=false`, כדי שקריאת-מסך לא תכתוב
ל-DB. פרטי הכיול: `docs/claude-usage-calibration-process.md`.

## מה נשאר לבנות — שלב 4

### 1. צד-שרת — endpoint `GET /claude/account-usage`

**הקוד כבר נכתב ונבדק לוגית אבל טרם נדחף** (היה ב-working tree של הסשן
הקודם, שהוא clone נפרד — לכן הקוד המלא כאן). הדבק אותו ב-
`server/src/modules/claude/routes.ts` **מיד אחרי** ה-handler של
`GET /claude/usage` (מסתיים סביב שורה 249), באותו router ובאותו gate:

```ts
/**
 * GET /claude/account-usage?account=<acct> — the live limit ESTIMATE for one
 * Claude account, for the composer's usage meter (the filling-circle icon).
 *
 * Reads the SAME estimator the alert cron uses (check_claude_usage_limits, called
 * dry-run so no notifications fire) for the rolling 5-hour window, plus a rolling
 * 7-day total for the weekly figure. This is an ESTIMATE from our own runs vs a
 * calibrated cap — NOT Anthropic's real remaining quota, which is not exposed on
 * a Team plan (see the /claude/usage disclaimer). Weekly has no calibration event
 * yet, so it is display-only.
 */
router.get("/claude/account-usage", async (req: Request, res: Response) => {
  const account =
    typeof req.query.account === "string" && req.query.account.trim()
      ? req.query.account.trim()
      : null;
  if (!account) return res.status(400).json({ error: "account required" });

  // 5-hour window from the shared estimator. p_dry_run=true → read-only, never
  // files an alert (that is the cron's job, not a screen read's).
  const { data: sessRows, error: sErr } = await db.rpc("check_claude_usage_limits", {
    p_dry_run: true,
  });
  if (sErr) {
    console.error("[claude/account-usage] estimator failed:", sErr.message);
    return res.status(500).json({ error: "usage unavailable" });
  }
  const s =
    (sessRows as { claude_account: string; window_end: string; cost_used: number; cap_cost: number; pct: number }[] | null)?.find(
      (r) => r.claude_account === account,
    ) ?? null;

  // Weekly: rolling 7-day cost vs the weekly cap (calibrated per-account, else '*').
  const weekSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: wkRows } = await db
    .from("claude_runs")
    .select("total_cost_usd")
    .eq("claude_account", account)
    .gte("created_at", weekSince);
  const weekCost = (wkRows ?? []).reduce(
    (a, r) => a + (Number(r.total_cost_usd) || 0),
    0,
  );
  const { data: capRows } = await db
    .from("claude_usage_limits")
    .select("claude_account, cap_cost_usd")
    .in("claude_account", [account, "*"])
    .eq("window_kind", "weekly");
  const weekCap = Number(
    capRows?.find((c) => c.claude_account === account)?.cap_cost_usd ??
      capRows?.find((c) => c.claude_account === "*")?.cap_cost_usd ??
      0,
  );

  return res.json({
    account,
    // Clamp the displayed percent to 100 — over-100 means "used up", and a meter
    // that fills past full reads as broken (this was the 272% bug in the alert).
    session: s
      ? {
          pct: Math.min(100, s.pct),
          pct_raw: s.pct,
          cost_used: Number(s.cost_used),
          cap: Number(s.cap_cost),
          window_end: s.window_end,
        }
      : null,
    weekly:
      weekCap > 0
        ? {
            pct: Math.min(100, Math.floor((weekCost / weekCap) * 100)),
            cost_used: Math.round(weekCost * 100) / 100,
            cap: weekCap,
          }
        : { pct: null, cost_used: Math.round(weekCost * 100) / 100, cap: null },
    disclaimer: "אומדן מהצריכה דרך הכלים שלנו — לא נתון רשמי מאנתרופיק",
  });
});
```

תגובה לדוגמה: `{ account, session:{pct,pct_raw,cost_used,cap,window_end}|null,
weekly:{pct,cost_used,cap}, disclaimer }`. `session=null` = אין חלון פעיל
כרגע (0% — הצג ריק/אפור). `pct` כבר חסום ל-100; `pct_raw` לטולטיפ בלבד.

### 2. צד-לקוח — רכיב `UsageMeter`

קובץ חדש `src/components/claude/UsageMeter.tsx`. Props: `{ account: string }`.

- **fetch** דרך `api()` מ-`@/lib/api/client` ל-`/api/claude/account-usage?account=${account}`.
  טען כשפותחים את ה-popover (לא poll רציף — קומפקטי/חסכוני), אפשר רענון כל ~60s בזמן שהוא פתוח.
- **האייקון** (ברירת-מחדל, תמיד גלוי): עיגול-התקדמות קטן שמתמלא לפי
  `session.pct` — SVG `<circle>` עם `stroke-dasharray`/`stroke-dashoffset`
  (בדיוק כמו מד ה-usage ב-claude.ai בצילום). צבע: אפור→כתום מ-70%, אדום
  מ-90%. גודל ~16px, יושב בתוך ה-toolbar כמו כפתור-אייקון (כלל ה-UI
  הקומפקטי: אייקון בלבד, פירוט בלחיצה).
- **בלחיצה**: `Popover` (מ-`@/components/ui/popover` — כבר בשימוש בריפו)
  עם שלוש שורות בסגנון הצילום:
  - `5 שעות` — bar + `pct%` מימין + "מתאפס בעוד X" (חשב מ-`session.window_end`,
    הצג בשעון **America/New_York**; שורש-פרויקט: זמנים למשתמש תמיד NY).
  - `שבועי` — bar + `pct%` (אם `weekly.pct=null` → "אין כיול עדיין").
  - שורת `disclaimer` קטנה ("אומדן — לא נתון רשמי מאנתרופיק").
- טולטיפ על האייקון: `pct_raw%` + `cost_used`/`cap` שווה-ערך.

### 3. חיבור ל-`ChatComposer`

- הוסף prop `account?: string` ל-`ChatComposer` (interface סביב שורה 48).
- ב-`ClaudeChat.tsx` (הרנדור סביב שורה 1563) העבר:
  `account={thread?.claude_account ?? (pending.claude_account as string | undefined) ?? lastAccount ?? DEFAULT_ACCOUNT}`
  (אותו ביטוי שכבר משמש את ה-`AccountSwitcher` בשורה ~1303).
- ב-`ChatComposer` toolbar (ה-`<div className="flex min-w-0 items-center gap-0.5">`
  בשורה ~314, שמחזיק את שני ה-`<Select>` של מודל+עוצמה): הוסף
  `{account && <UsageMeter account={account} />}` אחרי ה-Select של העוצמה.

### 4. i18n

הוסף מפתחות ל-**שני** `src/messages/he.json` ו-`src/messages/en.json`
באותו commit (חוק הריפו). תחת מרחב `claude.usage` (או `claude.meter`):
`title5h`, `titleWeekly`, `resetsIn`, `noCalibration`, `estimateDisclaimer`,
`tooltip` (עם params `pct`,`cost`,`cap`). כל מחרוזת גלויה עוברת
`useTranslations()` — לא ternary `he/en`.

## פרוטוקול לפני-דחיפה (חובה)

1. **`git fetch origin main` + `git rebase origin/main` תחילה** — origin
   התקדם מאז (prod היה על `ade8bbf`, מעבר ל-`ec2b389` שהיה ה-tip שלנו).
2. **build**: `npm install --no-audit --no-fund && npm run build`.
   ⚠️ **caveat סביבתי**: בחלק מה-sandbox החבילה
   `@tailwindcss/container-queries` חסרה פיזית ב-node_modules (npm מדווח
   "up to date" אך התיקייה ריקה), וה-build נכשל **רק** עליה — לא על הקוד.
   האפליקציה רצה ב-production, כלומר החבילה קיימת ב-Vercel. אם זה קורה:
   אמת עם `npx tsc --noEmit 2>&1 | grep -E "UsageMeter|ChatComposer"` (צריך
   0 שגיאות בקבצים שלך; שגיאת `tailwind.config.ts` היחידה = סביבתית),
   וסמוך על build של Vercel לפריסה המלאה.
3. **server build**: `cd server && npm run build` (tsc → dist) — מאמת את ה-endpoint.
4. **סקירת סוכן** על ה-diff (Step 3 בפרוטוקול הריפו).
5. **push main** ישירות (הרשאה עומדת), ואמת פרודקשן:
   `curl -s https://app.smrtesy.com/api/deploy-info` → `commit_short` תואם.
6. **אמת התנהגות** (לא רק SHA): `node /app/dist/modules/claude/browser-helper.js shot /he/claude --out shot.png --attach`,
   ואם אפשר פתח את ה-popover וּודא שהמד מוצג ומתמלא.

## שיפור מומלץ (חנוך ביקש לשקול) — כיול אוטומטי

היום ה-cap ידני ($53, כויל מ-ai3). כל חשבון חדש **יטעה** עד תיקון ידני —
בדיוק מה שקרה עם ai4 (הראה 148% על ברירת-מחדל $18 עד שכוילתי ל-$53). הנכון:
שהפונקציה **תלמד את התקרה לבד**. הלוגיקה: לכל חשבון, מצא את חלון ה-5h
האחרון שהסתיים במיצוי (`error LIKE 'usage-limit-wait%'`), סכם את
`total_cost_usd` **עד העצירה הסופית** (לא עד המיצוי המהבהב הראשון — זו
הייתה הטעות: ai3 "נחבט" ב-13:41 ב-$19 אך המשיך לעבוד עד ~$53 ב-14:22),
ועדכן `claude_usage_limits`. מומלץ לבנות יחד עם הכרטיס — בלעדיו הכרטיס יציג
מספרים שגויים לכל חשבון חדש.

## נתוני-אמת לעיון (2026-08-04, NY)

- **ai3** נחבט (session limit) אחרי ~$53 שווה-ערך בחלון 12:53→14:22; ה-reset
  שאנתרופיק דיווחה: 17:50 (אלגוריתם זיהוי-החלון נתן 17:56 — פער 6 דק',
  אימות שהוא מדויק).
- **ai4** ב-~$54, cap $53 → ~102%, `ever_hit=false` (על הסף; ייתכן tier מעט
  שונה או שהמדד לא מיושר מושלם — לכן אומדן).
- חשבונות האוטומציה רצים ב-org `dccf542d-ff50-4232-945b-0b6df7e510dc`.
- התראות נשלחות ל-super-admins שיש להם חברות-org (בפועל `chanoch770@gmail.com`).

## קבצים שנוגעים בהם

`server/src/modules/claude/routes.ts` (endpoint) · `src/components/claude/UsageMeter.tsx`
(חדש) · `src/components/claude/ChatComposer.tsx` (prop + רינדור) ·
`src/components/claude/ClaudeChat.tsx` (העברת account) · `src/messages/{he,en}.json`.
המיגרציה `supabase/migrations/20260804200000_claude_usage_limit_alerts.sql`
כבר קיימת ומוחלת — אל תיצור מחדש.
