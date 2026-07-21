# smrtTrade — מפתח-אימות מרכזי (INDEX)

מסמך-על אחד שממפה **כל בדיקה** → הסקריפט שהריץ אותה → נתוני-הקלט → התוצאה →
פקודת-השחזור המדויקת. נועד לביקורת ידנית: מכל שורה אפשר להגיע בדיוק לקוד ולנתונים
ולהריץ מחדש. **אין מספר שאי-אפשר לשחזר.**

**ריפו:** `smrtesy/mrtesy-app` · **ענף:** `claude/new-project-planning-he693h`
כל הנתיבים יחסיים ל-`docs/smrttrade-spike/`.

---

## 1. שכבות-המערכת (מנוע)

| רכיב | קובץ | תפקיד |
|---|---|---|
| מרשם-כללים | `../stock-course-rules.registry.json` | 192 כללים (core 176/report-cycles 15/investing 1); שדה `scope` |
| מנוע-החלטה | `harness.py` | `build_context()` (אינדיקטורים+רמות) + `decide()` (שערי כניסה/מעקב/הימנעות) |
| אינדיקטורים | `indicators.py` | sma/ema/rsi/macd/atr/swings/trend_structure |
| גלאי-רמות | `levels.py` | אשכולות-צירים → תמיכה/התנגדות משמעותית |
| מנוע-יציאה | `exit_engine.py` | כללי יא/ח: גאפ→סטופ→מימוש-2R→מבני→טריילינג (מומנטום כבוי=report-scope) |
| מפרט-יציאה | `exit-engine-spec.md` | פירוש כלל-אחר-כלל + תוויות-בסיס 🟢🟡🔴 |
| הפרדת-סקופ | `scope-separation-changelog.md` | מה הוצא מהליבה ל-report-cycles ולמה |

---

## 2. הבדיקות — כל אחת: הגדרה · סקריפט · נתונים · תוצאה · שחזור

הדוח המלא עם ההגדרות והמספרים: **`validation/VALIDATION-REPORT.md`**.
ביקורת בלתי-תלויה: **`validation/AUDIT-REPORT.md`** · פרומט-אימות: **`validation/VERIFIER-PROMPT.md`**.

| # | בדיקה | סקריפט | נתונים/פלט | תוצאה עיקרית |
|---|---|---|---|---|
| 4.1 | בדיקת-עיוור T1.4 מול זיו | `harness.py` | `LOCKED` בקוד | איכותית: שחזוריות+כיסוי-מלא ✔️ |
| 4.2 | בייק-אוף golden-set ינו-פבר26 | `goldenset/batch_janfeb2026.py` | `goldenset/ziv_verdicts_*.json`, `report-janfeb2026.md` | תיאום 61% < בסיס-טריוויאלי 86% |
| 4.3 | תוצאה-קדימה (14 מקרים) | — | `goldenset/forward-outcomes-janfeb2026.md` | רתמה 8 · זיו 3 · תיקו 3 |
| 4.4 | בקטסט 33 מנצחים | `goldenset/backtest_multiperiod.py` | `goldenset/mbt_trades.json`, `backtest-multiperiod.md` | +14.6R — **מוטה-שרידות** |
| 4.5 | בקטסט 106 מופחת-הטיה | `goldenset/backtest_reduced_bias.py` | `goldenset/ubt_trades.json`, `backtest-reduced-bias.md` | +0.178R — דק/שברירי |
| 4.7 | בדיקת-באג | (scratchpad `diag.py`) | תועד ב-VALIDATION-REPORT §4.7 | נקי; השליליות אמיתית |
| 4.8 | כיול-OOS 45 מניות | (גרסה מוקדמת של calib) | VALIDATION-REPORT §4.8 | +0.389R — **מיראז'** |
| 4.9 | כיול-OOS 285 מניות | `validation/calib_big.py` | פלט בדוח §4.9 | **−0.087R** (תנאים ריאליים) |
| 4.10 | בקרת כניסות-אקראי | `validation/montecarlo.py` | פלט בדוח §4.10 | כניסות-מנוע = **אקראי** |
| #1 | סלקטיביות: זיו מול מנוע מול אקראי | `validation/ziv-selection/ziv_selection_test.py` | `ziv-selection/RESULTS.md` | ⛔ **v1 לא-תקף** — זיו נותן כיוון בלבד; כניסה/יציאה חייבות כללי-קורס-מלאים (לא קיימים). דורש מימוש-מלא קודם |

### פקודות-שחזור
```
# 4.9 — כיול-OOS על יקום רחב (285 מניות)
cd docs/smrttrade-spike/validation && python3 calib_big.py

# 4.10 — בקרת כניסות-אקראי (Monte-Carlo, זרע 1234)
cd docs/smrttrade-spike/validation && python3 montecarlo.py

# בדיקת-עיוור בודדת (נקודת-בזמן)
SMRTTRADE_CUTOFF=2026-01-28 python3 docs/smrttrade-spike/harness.py NFLX ZM CRH
```
כל הסקריפטים: Python3 בלבד, נתוני-מחיר חינם מ-Yahoo chart API. אין תלות בתשלום.

---

## 3. בדיקה #1 — סלקטיביות-זיו (מבנה התיקייה `validation/ziv-selection/`)

השאלה: האם בחירת-הכניסה של **זיו** (קריאת-גרף אנושית) מוסיפה תוחלת מעל **המנוע**
ומעל **אקראי**, דרך אותו מנוע-יציאה בדיוק, על אותם תאריכים?

| תיקייה/קובץ | תוכן |
|---|---|
| `ziv-selection/README.md` | פרוטוקול אי-דליפה, מקורות, שיטה |
| `ziv-selection/ziv_fetch_manifest.json` | כל סרטוני-הזיו שנמשכו: id, תאריך, כותרת, אורך-תמלול |
| `ziv-selection/transcripts/` | תמלולי-כתוביות (iw) גולמיים — קלט-החילוץ (לאימות ידני מול הסרטון) |
| `ziv-selection/verdicts/` | פסקי-זיו שחולצו, **עם ציטוט-מגבה לכל פסק** (schema: ticker/label/quote/levels) |
| `ziv-selection/ziv_selection_test.py` | הבדיקה: זיו-picks מול engine-picks מול random, אותו מנוע-יציאה |
| `ziv-selection/RESULTS.md` | התוצאה + פרשנות |

**מקור-הפסקים:** קבצי-הזיו של ינו-פבר26 מגיעים מ-`goldenset/ziv_verdicts_*.json`
(5 סרטונים); סרטוני אפר-מאי26 חדשים מ-`ziv-selection/verdicts/` (9 סרטונים בשלים).
סרטונים טריים (יוני-יולי26, <8 שבועות קדימה) נמשכו אך **מסומנים לא-בשל ומוחרגים**.

**פרוטוקול אי-דליפה:** סוכני-חילוץ נפרדים קראו **רק את התמלול** (לא מחירים, לא
פלט-מנוע). הכניסה בפועל בפתיחת-היום-שאחרי הסרטון. "כניסת-זיו פעילה" = `כניסה` או
`מעקב·אזור-כניסה`.

---

## 4. עקרונות שנשמרים לאורך כל הבדיקות
- **נקודת-בזמן:** כל החלטה משתמשת רק בנתונים עד תאריך-ההחלטה (אין הצצה קדימה).
- **כניסה בפתיחה-הבאה:** ברירת-המחדל הריאליסטית (לא סגירת-יום-ההחלטה).
- **תוויות-בסיס:** 🟢 מחושב · 🟡 פרוקסי · 🔴 שיקול-דעת (מוצג כהצעה ניתנת-לעריכה).
- **fail-closed:** כלל computable ללא מעריך חוסם ENTRY (לא מדלג בשקט).
- **עלות/החלקה:** 0.30% לעסקה בכל הבקטסטים.
- **יחידה:** R = יחידת-סיכון (1R = מרחק-הסטופ). ב-1% סיכון/עסקה: ‎+N R ≈ ‎+N% חשבון.
