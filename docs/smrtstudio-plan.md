# smrtStudio — מערכת ניהול הפקת וידאו ב-AI

> **מה זה:** תוכנית לאיחוד כל מה שקשור להפקת תוכן ב-AI למערכת ניהול-פרוייקט אחת.
> **סטטוס:** טיוטה v2 לאישור · 2026-07-26 (ניו יורק) · ענף `claude/video-project-management-system-tizxhx`
> **v2 — מה השתנה מ-v1 (בעקבות ביקורת המשתמש):** ① רשימת השוטים תלויה במודל
> (משך = enum, לא טווח) → נוספה "רשת 5 שניות" ובדיקת נשיאוּת · ② שלב התמונות מפיק
> **זוג** פריימים (פתיחה+סיום) ונכסי מקום/פריט הם ישויות · ③ מצבי שלב הם **שני צירים
> בלתי-תלויים**, לא סולם — חזרה למחקר לא מוחקת הכרעה · ④ **smrtVoice מתאחד**:
> עמוד שדרה אחיד + פרופיל לכל סוג פלט. v1 השאיר אותו בנפרד — נימוק שגוי, מתוקן כאן.

---

## 1. מה קיים היום (נסרק 2026-07-26)

### smrtVoice — קול (עובד)
`smrtvoice_projects` (סטטוס, עלות, Drive) → `smrtvoice_scripts` (`code`, Google Doc)
→ `smrtvoice_lines` → **`smrtvoice_line_takes`**: `model`, `resemble_voice_id`,
`text_used`, `output_audio_path`, `duration_seconds`, `cost_usd`, `approved`, `note`.
בנוסף: `_pronunciation_lexicon`, `_pronunciation_feedback`, `_learning`,
`style_baseline`, נורמליזציית loudness, שיבוט קול, תור jobs, reconciler.

### smrtPlan — תכנון + מסך התוצרים (עובד)
`smrtplan_plans` ומטריצה · **`experiment_runs`**: `code`, `model`, `method`, `prompt`,
`seed`, `cost_usd`, `output_url`, `meta` + QC (`qc_status/score/reason/scores`,
`overridden`) · **`experiment_scores`**: 1-5 לפי `dimension`×`scorer`, `locked` ·
**`/plan/score`** — גריד מודל×שוט מלוטש (673 שורות), thumbnails, lightbox, סינון QC.

### video-lab — המחקר (עובד, ברפו)
18 מתכוני מודלים עם **סכמות מאומתות מול fal OpenAPI** · `shortlist-image/video/lipsync.json`
· `prices-memo.md` · `concurrency.json` · `qc-models.json` · `pipeline.md` · `harness/`.

### הפער — ובראשו הפער שלא ראיתי ב-v1

1. אין מסך אחד. 2. הפרובננס חלקי (`method` הוא תיאור, לא ה-payload). 3. המחקר לא
נגיש מהמסך. 4. הציונים לא נצמדים למודל. 5. אין יומן החלטות. 6. אין מקום לשיטות.
7. אין תצוגת חוץ.

**8. שתי מערכות מקבילות לאותה צורה.** `smrtvoice_line_takes` ו-`experiment_runs` הם
**אותה ישות** — תוצר + מודל + הגדרות + עלות + הכרעה — במימוש כפול. וזה לא רק כפילות
קוד: הצד של האודיו **חלש יותר**. אין payload מדויק, אין request id, וההכרעה היא
`approved boolean` במקום ציון לפי מדדים. כל שיפור באמינות או בניקוד צריך להיבנות
פעמיים, ובפועל נבנה רק בצד אחד.

---

## 2. העיקרון: עמוד שדרה אחיד, פרופיל לכל סוג פלט

> *"צריך תכנון של מערכת אחידה, ואז שינוי פרטי שמתאים לכל פלט."*

זו התשובה גם לשאלה למה smrtVoice לא יכול להישאר בנפרד.

### מה אחיד — זהה לכל סוג פלט, בלי חריגים

| # | שכבה | למה חייב להיות אחיד |
|---|---|---|
| 1 | **פרוייקט** — `studio_projects` | "כמה פרוייקטים" חייב לכלול פרוייקטי קול. שתי הנהלות חשבונות לאותו דבר מתפצלות תמיד |
| 2 | **תוצר** — `output_kind` ∈ `image`\|`video`\|`audio`\|`text`\|`composite` | תוצר הוא תוצר. אחרת המסך הראשי לא יכול לספור |
| 3 | **פרובננס** — `endpoint_id` + `input_args` + `request_id` + `cost_basis` + write-once + תג אמינות | האמינות היא הדרישה המרכזית. היא לא יכולה לחול על fal ולא על Resemble |
| 4 | **סבב + הכרעה** — משקולות שננעלו לפני התוצאות, יומן, הכרעה שמוחלפת ולא נמחקת | אחרת אין השוואה תקפה ואין היסטוריה |
| 5 | **קטלוג** — `studio_models` כולל `category='voice'` | "כל המודלים במקום אחד" כולל מודלי קול |
| 6 | **נכסים** — `studio_assets` (דמות/מקום/פריט/סגנון/**קול**) עם נעילה וגרסאות | פרופיל קול הוא נכס נעול בדיוק כמו רפרנס דמות |
| 7 | **שיטות ומחקר** — `scope` + `stage_slugs` | ידע הוא ידע |

### מה משתנה לפי סוג פלט — `studio_output_profiles` (טבלה נזרעת, לא enum בקוד)

| | image | video | lipsync | **audio** | text (תסריט) |
|---|---|---|---|---|---|
| **מדדי ניקוד** | עקביות | עקביות · תנועה · איכות | + ליפסינק | **היגוי עברית · טבעיות · התאמת רגש · עקביות קול בין טייקים · קצב · ארטיפקטים** | בהירות · נאמנות למקור · אורך |
| **QC אוטומטי** | DINO / CLIP-I / דמיון-פנים | + זרימת תנועה | + מדד ליפסינק | **תמלול→WER · בדיקת היגוי מול הלקסיקון · LUFS · זיהוי חיתוך/רעש** | — (אנושי) |
| **יחידת השוואה** | שוט × מודל | שוט × מודל | קליפ × מודל | **שורה × קול/מודל** | גרסה × גרסה |
| **נגן** | תמונה + lightbox | וידאו | וידאו + אודיו | **גל-קול + נגן, השוואת טייקים** | diff טקסט |
| **מנוע הפקה** | רתמת fal | רתמת fal | רתמת fal | **smrtVoice (Resemble)** | LLM + עריכה |
| **מה נעול** | רפרנס קנוני | המודל + הגדרות | המודל | **פרופיל הקול + הלקסיקון** | התסריט המאושר |

**מה נשאר smrtVoice ולא זז:** תור ה-jobs, טייקים, לקסיקון ההיגוי, שיבוט קול,
נורמליזציית loudness, מנגנון הלמידה, ה-reconciler. זו **מכונת הפקה ספציפית לשלב**,
בדיוק כמו ש-`harness/` היא מכונת ההפקה של fal. אף אחת מהשתיים לא נעלמת.

**מה עולה לשכבה האחידה:** הפרוייקט, התוצר, הפרובננס, הניקוד, ההכרעה.

**בונוס — פרופיל האודיו לא מומצא מאפס.** `smrtvoice_pronunciation_lexicon`,
`_pronunciation_feedback`, `_learning`, `style_baseline` ונורמליזציית ה-loudness
**הם כבר** שיטת הבדיקה וההחלטה של האודיו — רק לא בתוך המסגרת המשותפת. הפרופיל מרים
אותם לתוכה, לא מחליף אותם.

### מיגרציה — view לפני מיגרציה, בלי לשבור כלום

| שלב | מה | מה נשבר |
|---|---|---|
| א | `studio_projects` נוצר · `smrtvoice_projects` מקבל `studio_project_id` (nullable) · backfill 1:1 | כלום. שני המסכים עובדים במקביל |
| ב | **view `studio_outputs_all`** = `experiment_runs` ∪ `smrtvoice_line_takes` לצורת-שורה אחת עם `output_kind` | כלום. המסך המאוחד עובד בלי לגעת בדאטה |
| ג | פרובננס אודיו מתחזק **בכתיבה** (payload מדויק ל-Resemble, request id) — כמו שלב 0 של fal | כלום. שורות עבר נשארות 🟡 ביושר |
| ד | טבלה מאוחדת — **רק אם** ה-view מתגלה כלא-מספקת | — |

הרעיון: מאחדים את **השכבה** דרך view, ומעבירים אחסון רק אם צריך. שלב ד עשוי לא
להידרש לעולם.

---

## 3. השלב הוא מפתח-החיבור

כל ישות נושאת `stage_slug`. לשיטות ולמחקר יש `scope`: `general` (כולל **"איך עורכים
מחקר"** ו"איך בונים תוכנית עבודה") · `stage` · `model`. פריט נכתב פעם אחת, נושא
`stage_slugs text[]`, ומופיע בכל מקום ששייך לו. ספרייה אחת מסוננת לפי הקשר — לא שני
מסכים.

### רשימת השלבים

| # | slug | שם | מפיק | סוג פלט |
|---|---|---|---|---|
| 1 | `concept` | רעיון ונושא | מסמך הסדרה | `text` |
| 2 | `script` | תסריט | תסריט מאושר | `text` |
| 3 | `shotlist` | רשימת שוטים | שוטים על רשת-משך + טקסטים למסך | `text` |
| 4 | `assets` | נכסים | דמויות · **מקומות · פריטים** · סגנון · **פרופילי קול** | `image` + `audio` |
| 5 | `voice` | קול | טייקים בשתי שפות | `audio` |
| 6 | `stills` | פריימים | **זוג** לכל שוט: פתיחה + סיום | `image` |
| 7 | `motion` | וידאו | קליפים | `video` |
| 8 | `lipsync` | ליפסינק | קליפים מסונכרנים | `video` |
| 9 | `assembly` | הרכבה | חיבור, מוזיקה, שכבות טקסט | `composite` |
| 10 | `qc` | בדיקה ואישור | דוח + הכרעה | — |
| 11 | `delivery` | אספקה | גרסה סופית ×2 שפות | `composite` |

**חוצי-צינור** (שורה שנייה, לא על הציר): `research` · `criteria` · `cost` · `runbook`.

---

## 4. שלב 3 — רשימת השוטים תלויה במודל. הפתרון: רשת 5 שניות

השאלה שלך: *"האם זה נוגע לאיזה מודל משתמשים? נוגע לאורך וליכולת של מודל?"*
**כן, ובאופן חמור.** מהסכמות המאומתות (fal OpenAPI, 2026-07-24):

| מודל | `duration` המותר | end/tail frame | מחיר לשנייה |
|---|---|---|---|
| Kling 2.5 turbo pro i2v | `'5'` \| `'10'` **בלבד** | `tail_image_url` ✓ | $0.35/5ש׳ + $0.07/ש׳ |
| Kling v3 pro i2v | `'3'`…`'15'` | `end_image_url` ✓ + `elements` + `multi_prompt` | $0.112/ש׳ (אודיו כבוי) |
| Seedance 2.0 i2v | `auto` \| 4…15 | `end_image_url` ✓ | $0.3024/ש׳ |
| Veo 3.1 i2v | `'4s'` \| `'6s'` \| `'8s'` **בלבד** | ✗ | $0.10/ש׳ (Fast) |
| pixverse v6 i2v | int (ברירת-מחדל 5) | ✗ | $0.045/ש׳ @720p |
| happy-horse v1.1 i2v | int 3…15 | ✗ | $0.14/ש׳ @720p |

שלוש מסקנות:

1. **שוט של 7 שניות אינו נשיא.** חוקי ב-Kling v3 / Seedance / happy-horse,
   **בלתי אפשרי** ב-Kling 2.5 (5\|10) וב-Veo (4\|6\|8).
2. **אין משך שכל השישה מקבלים.** 5 פסול ב-Veo, 4 פסול ב-Kling 2.5.
3. **אורך השוט הוא מחיר.** שוט 12ש׳ ב-Seedance ≈ $3.63; אותו שוט כ-5+5 ב-Kling 2.5
   ≈ $0.70. **זהו מנוף העלות הגדול ביותר בפרק.**

### השיטה האחידה — ומה היא לא מבטיחה

> *"או שאפשר ליצור שיטה אחידה שתעבוד ותנצל בצורה אחידה את כל המודלים."*

אחידה מלאה על כל השישה — **לא**, כי אין חיתוך משותף. אבל אחידה על המובילים, כן:

- **חותכים על רשת של 5 שניות** — כל שוט הוא 5 / 10 / 15. חוקי ב-Kling 2.5, Kling v3,
  Seedance ו-pixverse (ארבעת המובילים).
- **שוט ארוך = שרשור פעימות**: מפצלים לפעימות של 5ש׳, כאשר **פריים הסיום של פעימה N
  = פריים הפתיחה של N+1** (`tail_image_url` / `end_image_url`). זה גם מאפשר שוטים
  ארוכים **וגם** שומר על הדמות זהה לרוחב החיתוך — אותו מנגנון, שני רווחים.
- **Veo 3.1 מוכרז חריג מתועד.** רשת 4/6/8 → מעבר ל-Veo מחייב חיתוך מחדש. הוא מדורג 6
  ומסומן "fallback איכות" — אז מסמנים אותו **"לא על הרשת"** במקום להעמיד פנים שהוא
  מתחלף.
- לשוט שאין ברירה שיהיה 7ש׳ — נרשם כ-`off_grid` עם הסיבה, וה-UI מזהיר על מי אפשר
  להריץ אותו.

### מה זה דורש בסכמה

`studio_shots`: `shot_no`, `scene`, `description`, `target_seconds` (על הרשת),
`beats jsonb` (הפירוק ל-5ש׳), `dialogue_line_id` → `smrtvoice_lines` (הקישור לאודיו),
`on_screen_text`, `characters[]`, `location_asset_id`, `prop_asset_ids[]`,
`needs_lipsync`, `off_grid` + `off_grid_reason`, `portable_to[]` (מחושב).

`portable_to` **נגזר מ-`studio_models.arg_schema`** — הסכמה המאומתת שסונכרנה מהרפו —
ולא מרשימה בקוד. כשנועלים מודל אחר, ה-UI מסמן מיד אילו שוטים לא נשיאים אליו.

**ההשלכה על התכנון:** שלב 3 לא יכול להיסגר לפני ששלב 7 יודע איזה מודל וידאו נעול,
או לפחות מה הרשת המשותפת של המועמדים. אז יש **תלות אמיתית** `motion` → `shotlist`,
והיא צריכה להיות מפורשת במסך.

---

## 5. שלב 6 — זוג פריימים, ורקעים ופריטים כישויות

### א. פריים אחרון — כן, ב-3 מ-6

`tail_image_url` (Kling 2.5) · `end_image_url` (Kling v3, Seedance). **לא**: Veo,
pixverse, happy-horse.

לכן שלב 6 לא מפיק תמונה אחת לשוט אלא **זוג**: `frame_role` ∈ `start` \| `end`.
ופריים הסיום של שוט N יכול להיות פריים הפתיחה של N+1 — אותה שורת נכס, שני תפקידים.
זה מה שמחזיק דמות זהה לאורך פרק של 10-12 דקות, ולא רק בתוך קליפ בודד.

**כשהמודל הנעול לא תומך ב-end frame** — מפיקים רק `start`, והשרשור נעשה בעריכה
(שלב 9) במקום במודל. הבחירה נרשמת בהכרעה, לא נשכחת.

### ב. מקומות ופריטים — פער אמיתי ב-v1, נסגר

*"איפה נכנס תמונות רקע של מקום ופריטים."* — ב-v1 היה `assets` בלי תת-סוגים ובלי
רישום מה נכנס לאיזה תוצר. מה שהסכמות מאפשרות:

- **מודלי תמונה מקבלים מערך רפרנסים:** `image_urls` עד 14 (nano-banana-pro/edit),
  עד 10 (seedream/v5/pro/edit). כלומר פריים **מורכב** מ-[רפרנס דמות + רפרנס מקום +
  רפרנס פריט + רפרנס סגנון].
- **Kling v3 מקבל `elements`** (1-4 רפרנסים, `@Element1` בפרומפט) — מקום או פריט
  נכנסים **ישר למודל הווידאו**, לא רק לתמונה.

לכן:

`studio_assets`: `asset_kind` ∈ `character` \| `location` \| `prop` \| `style` \|
`voice_profile` \| `reference_sheet` · `canonical_url` · `version` · `locked_at` ·
`superseded_by` · `prompt_token` (השם שבו קוראים לו בפרומפט, למשל `@Element1`).

`studio_output_assets`: `output_id` × `asset_id` × `role` (`identity` / `location` /
`prop` / `style` / `start_frame` / `end_frame`).

הרפרנסים כבר יושבים בתוך `input_args.image_urls` — אבל קישור מדרגה-ראשונה הוא מה
שמאפשר לשאול את שתי השאלות שבאמת נשאלות:
1. אילו תוצרים השתמשו במקום "הכיתה"?
2. אם החלפנו את רפרנס הכיתה לגרסה 2 — **מה צריך להיבנות מחדש?**

זה גם מה שאוכף את כלל "נכס נעול לא נוצר מחדש": נעילה + גרסאות + מי תלוי במי.

---

## 6. מצבי שלב — שני צירים, לא סולם

> *"יהיה הרבה פעמים מצב שעברנו ממחקר לבדיקה, וחזרנו למחקר, כי יש פרטים חדשים
> שעכשיו גילינו. שלבים הם לא מצב החלטי."*

צודק. הסולם של v1 (`לא התחיל → במחקר → בבדיקה → … → נעול`) מניח מסלול חד-כיווני,
ולכן חזרה למחקר נראית בו כרגרסיה — ובנוסף מוחקת את ההכרעה הקיימת. שניהם שגויים.

**המודל המתוקן — שני צירים בלתי-תלויים:**

```
ציר 1 — מה עושים עכשיו (activity)
  לא פעיל · מחקר · בדיקה · ניקוד · הפקה · תקוע

ציר 2 — מה מצב ההכרעה (decision_state)
  אין · מוביל זמני · הוכרע · נעול · הוכרע-ונסתר
```

הם נעים בנפרד. `activity = מחקר` **וגם** `decision_state = הוכרע` הוא מצב תקין
ונפוץ — זה בדיוק "חזרנו למחקר כי גילינו פרטים חדשים": **ההכרעה הקודמת נשארת בתוקף
ובשימוש** עד שהכרעה חדשה מחליפה אותה. חזרה למחקר לא מוחקת את התשובה הטובה ביותר
שיש לנו — זו התכונה הקריטית.

**שלוש תוספות שנגררות מזה:**

1. **יומן מעברים** — `studio_stage_transitions`: `from`, `to`, `trigger` (**מה
   גילינו**), `who`, `when`. הלופים הם העבודה האמיתית; המסך מציג אותם במקום להסתיר.
   בתצוגת התורם זה נכס, לא חולשה — זו ההוכחה שהעבודה שיטתית.
2. **"מוביל עד-כה" כשדה מדרגה-ראשונה** — `leading_model_id` + `leading_score` (כלל 12
   של video-lab). שלב ב-`מחקר` עדיין מציג את הטוב-ביותר הנוכחי.
3. **אין אחוזי התקדמות על שלב מחקר.** אחוז מרמז על מסלול מונוטוני. במקומו:
   `סבבים: 3 · מוביל: Kling 2.5 · 4.1 · רף: 4.0 · פתוח מ-12 ביולי`.

`נעול` נשאר מצב מיוחד: נכס/מודל שלא נוצר מחדש. יציאה מ-`נעול` דורשת רשומת החלטה
מפורשת ב-`studio_decisions` עם `superseded_by` — לא לחיצה.

---

## 7. אמינות התוצר — החוזה (אחיד לכל סוג פלט)

היום נשמר `method` — טקסט חופשי **שמתאר** את השיטה — ולא ה-payload. ובצד האודיו
נשמרים `model` + `resemble_voice_id` בלבד. שתיהן חלקיות.

| # | מה | שדה | fal | Resemble |
|---|---|---|---|---|
| 1 | המודל המדויק | `endpoint_id` verbatim | `fal-ai/nano-banana-pro/edit` — לא `nano-banana-pro`: base הוא t2i, `/edit` הוא רפרנס | מודל + `voice_id` |
| 2 | **ההגדרות המדויקות** | `input_args jsonb` — ה-JSON שנשלח בפועל, אחרי פתירת ברירות-מחדל | ✗ היום | ✗ היום |
| 3 | מה חזר | `request_id`, `duration_ms`, `output_meta` | ✗ | ✗ |
| 4 | לפי איזה מתכון | `recipe_source` = `docs/models/<slug>.md@<sha>` | ✗ | — |
| 5 | מה זה עלה | `cost_usd` + `cost_basis` (מקור המחיר + היחידה) | חלקי | חלקי |
| 6 | מה ה-QC אמר | `qc_status/score/scores/reason`, `overridden` | ✓ | ✗ (יתווסף: WER, היגוי, LUFS) |
| 7 | מי ניקד ומה | `experiment_scores` — מנקד × מדד × זמן | ✓ | ✗ (`approved bool`) |
| 8 | מאיפה נגזר | `derived_from` | ✗ | ✗ |
| 9 | אילו נכסים נכנסו | `studio_output_assets` | ✗ | ✗ |

**שני כללים שהופכים את זה לאמין:**

**א. פרובננס write-once.** trigger שמונע שינוי של `endpoint_id`, `input_args`, `seed`,
`request_id` מערך לא-null לערך אחר. הרצה מחדש = **שורה חדשה** עם `derived_from`.
(`experiments.ts:153-162` כבר ממזג `meta` במקום לדרוס — אחרי שדריסה מחקה רפרנס.
הכלל מקבע את זה בסכמה במקום בקוד.)

**ב. תג רמת-אמינות — בלי להעמיד פנים:**
🟢 **מאומת** (`input_args` + endpoint מאומת מול OpenAPI + `recipe_source`) ·
🟡 **חלקי** (השורות מלפני התיקון — כולל **כל** טייקי האודיו הקיימים) ·
⚪ **ידני**.

---

## 8. קטלוג המודלים, ציונים, שיטות, מחקר, החלטות

### קטלוג — מקור-אמת היברידי (כפי שאושר)
```
video-lab (רפו) ──► POST /studio/models/sync ──► studio_models (DB)
 docs/models/*.md    (GitHub Action, x-cron-secret)   מחקר לקריאה בלבד
 shortlist-*.json                                            +
 concurrency.json                                    ציונים · הרצות · החלטות
```
חד-כיווני, אידמפוטנטי לפי `content_hash`, ה-DB לא כותב לשדות מחקר. הסקילים ממשיכים
לקרוא מהקבצים — כלל 5 של video-lab לא נשבר. **המנגנון הוא GitHub Action**, לא הוראה
ב-CLAUDE.md.

**קטגוריות:** `image` · `video` · `lipsync` · **`voice`** · `qc` · `edit` · `other`.
כל קטגוריה ממופה לשלבים שהיא משרתת.

**סינון מתקדם** (מקופל כברירת מחדל, נפתח באייקון): קטגוריה · טווח מחיר · מהירות ·
תגי יכולת (`multi-reference` וכמה · `end_frame` · `elements` · `audio_input` ·
`i2v`/`t2i` · `region-edit` · `seed` · **`duration` המותר** · רזולוציה) · לאיזה שלב ·
`verified_only` · `has_our_score` · ציון מינימלי · סטטוס.

`duration` המותר הוא שדה סינון מדרגה-ראשונה — כי הוא מה שקובע נשיאוּת של שוט (§4).

### ציונים שמצטברים לידע — view, לא טבלה
```sql
create or replace view studio_model_score_summary as
select r.model, r.endpoint_id, r.stage_slug, r.output_kind, s.dimension,
       round(avg(s.score)::numeric, 2) as avg_score, count(*) as n,
       min(s.score), max(s.score), max(s.created_at) as last_scored_at,
       count(distinct r.test_round_id) as rounds
from studio_outputs_all r join experiment_scores s on s.run_id = r.id
group by 1,2,3,4,5;
```
מ-`studio_outputs_all` — כלומר **מודלי הקול מקבלים ציון מצטבר באותו מנגנון**.
הציון המשוקלל נגזר מ-`studio_test_rounds.criteria` — המשקולות שננעלו **לפני**
התוצאות. זה מה שנותן תוקף להשוואה.

### שיטות · מחקר · החלטות
- **`/studio/methods`** — כותרת · scope · גוף · **סטטוס** (`טיוטה`/`בבדיקה`/`מוכחת`/
  `הוצאה משימוש`) · ביטחון · **עודכן לאחרונה + מי** · תוצרים שמוכיחים.
  נכנס מיד: בניית תוכנית עבודה (general) · עיגון דמות (`stills`) · **רשת 5 השניות
  והשרשור** (`shotlist`+`motion`) · **היגוי עברית ולקסיקון** (`voice`) · ניקוד
  (`qc`) · אישור עלות · המשכה-מנקודת-עצירה · בטיחות תוכן.
- **`/studio/research`** — **כללי** (כאן גר *"איך עורכים מחקר"*: התאמה→מחיר→מהירות ·
  רשמי **וגם** קהילה · פאנל מדורג 3→3 · **הסכמה קובעת את החוזה, לא השיווק** · אין
  hedge בתוצר גמור · כל סבב = אישור עלות · תמיד לשמור "מוביל עד-כה") + **לפי שלב**
  (אותם פריטים, `stage_slugs`). כל פריט: שאלה · פרוטוקול · **מקורות עם URL verbatim** ·
  מסקנות · הכרעה · ביטחון · עלות · תאריך · **מה השתנה בעקבותיו**.
- **`/studio/decisions`** — מה הוכרע · למה · **על סמך אילו תוצרים וציונים** · **מה
  נדחה ולמה** · מי ומתי · הפיך? · `superseded_by`.

---

## 9. מסכים

| מסלול | תפקיד |
|---|---|
| `/studio` | **לוח המצב** — ציר ההפקה עם שני הצירים לכל שלב, פרוייקטים, סבבים, החלטות |
| `/studio/projects/[id]` | פרוייקט: מטריצת שלבים, תסריטים, שוטים, תוצרים, עלות |
| `/studio/stages/[slug]` | שלב: שני הצירים, מוביל עד-כה, יומן מעברים, סבבים, שיטות ומחקר |
| `/studio/shots` | רשימת השוטים: רשת-משך, פעימות, נשיאוּת למודל הנעול, קישור לשורת האודיו |
| `/studio/assets` | נכסים לפי סוג, נעילה, גרסאות, **מה תלוי בכל נכס** |
| `/studio/outputs` | הגריד הקיים + תעודת יוחסין + סינון + תג אמינות · **`output_kind` מחליף נגן ומדדים** |
| `/studio/models[/slug]` | קטלוג + עמוד מודל (המתכון, הסכמה, ההרצות, הציונים) |
| `/studio/methods` · `/research` · `/decisions` | ספריות הידע |
| `/studio/share/[token]` | תצוגת חוץ לקריאה בלבד |

**המסך הראשי:** כל מספר הוא קישור עמוק. מצב `?view=presentation` מסתיר עלויות ופרטים
פנימיים. פילטרים מקופלים כברירת מחדל. תאריכים בשעון ניו יורק.

`/plan/score` נשאר עובד כ-redirect — יש קישורים עמוקים אליו על כרטיסי משימות.

---

## 10. סכמה

| טבלה | תפקיד |
|---|---|
| `studio_projects` | **הפרוייקט היחיד.** `kind`, `status`, `plan_id`→smrtplan, `budget_usd`, `languages` |
| `studio_stages` | קטלוג שלבים (נזרע) |
| `studio_project_stages` | **`activity` + `decision_state`** (שני צירים) · `leading_model_id` · `leading_score` · `description` · `blocker` · `updated_at` |
| `studio_stage_transitions` | `from`→`to`, `trigger`, `who`, `when` — **יומן הלופים** |
| `studio_output_profiles` | **פרופיל לכל `output_kind`**: מדדים, QC, נגן, יחידת השוואה (נזרע) |
| `studio_shots` | `target_seconds`, `beats`, `off_grid`, `portable_to`, `dialogue_line_id`, נכסים |
| `studio_assets` | `asset_kind` (כולל `location`/`prop`/`voice_profile`), `version`, `locked_at`, `superseded_by`, `prompt_token` |
| `studio_output_assets` | תוצר × נכס × `role` (כולל `start_frame`/`end_frame`) |
| `studio_test_rounds` | `criteria jsonb` (משקולות שננעלו), `threshold`, `winner`, `budget_usd` |
| `studio_models` | `endpoint_id`, `category`, `price`, `capabilities`, **`arg_schema`**, `schema_verified_at`, `research_md`, `source_sha`, `content_hash` |
| `studio_methods` · `studio_research` · `studio_decisions` · `studio_shares` | ספריות הידע + שיתוף |

**הרחבת `experiment_runs`** (nullable/ברירת-מחדל — לא שובר): `project_id`,
`stage_slug`, `test_round_id`, **`output_kind`**, `endpoint_id`, `input_args`,
`output_meta`, `request_id`, `recipe_source`, `harness_version`, `duration_ms`,
`cost_basis`, `derived_from`, `frame_role`, `shot_id`, `provenance_level`, `status`,
`error`.

**`smrtvoice_line_takes`**: `studio_project_id`, `input_args`, `request_id`,
`cost_basis`, `provenance_level`.

**View `studio_outputs_all`** = `experiment_runs` ∪ `smrtvoice_line_takes` בצורת-שורה
אחת. זו הישות שכל המסכים והצירופים קוראים.

---

## 11. Endpoints

**מכונה** (x-cron-secret, אידמפוטנטי): `POST /studio/runs` (פרובננס מלא, מחליף
`/experiments/runs` שנשאר לתאימות) · `/studio/upload` · `/studio/models/sync` ·
`/methods/sync` · `/research/sync` · `/studio/stage-status` (שני הצירים + trigger) ·
`/studio/decisions` · `/studio/rounds` (משקולות **לפני** התוצאות) · `/studio/shots` ·
`/studio/assets`.

**מחובר** (`requireAuth + requireOrg + requireApp("smrtstudio")`):
`/studio/dashboard` (קריאה אחת) · `/projects[/:id]` · `/stages[/:slug]` · `/shots` ·
`/assets` · `/outputs` (+סינון לפי `output_kind`) · `/outputs/:id/provenance` ·
`/models[/:slug]` · `/methods` · `/research` · `/decisions` · `POST /scores` ·
`/override` · `POST /shares`.

**ציבורי** (טוקן חתום): `GET /studio/public/:token/*` — סינון עלויות ו-`input_args`
**בשרת**, לא ב-UI.

---

## 12. שלבי בנייה

| שלב | מה | למה עכשיו | גודל |
|---|---|---|---|
| **0** | **קיבוע האמינות** — הרחבת `experiment_runs`, trigger write-once, הרתמה כותבת `input_args`/`endpoint_id`/`recipe_source`/`request_id` | כל הרצה עד שזה קיים נשארת 🟡 לנצח | קטן |
| **0ב** | **אותו דבר לאודיו** — `smrtvoice_line_takes` מקבל payload ו-request id | אותו נזק מצטבר, בצד שלא ראיתי ב-v1 | קטן |
| **1** | **השלד** — רישום האפליקציה · `studio_projects` (+`studio_project_id` על פרוייקטי קול, backfill) · שלבים · שני הצירים · יומן מעברים · `/studio` + עמוד פרוייקט + עמוד שלב | המסך הראשי הוא הדרישה המרכזית | בינוני |
| **2** | **התוצרים המאוחדים** — view `studio_outputs_all` · הגריד עובר ל-`/studio/outputs` · `studio_output_profiles` (נגן ומדדים לפי `output_kind`) · תעודת יוחסין · תג אמינות | כאן האיחוד נראה על המסך בפעם הראשונה | בינוני-גדול |
| **3** | **שוטים ונכסים** — `studio_shots` עם רשת 5ש׳ ובדיקת נשיאוּת · `studio_assets`+`studio_output_assets` (מקומות, פריטים, זוגות פריימים) | חוסם הפקת פרק אמיתית | בינוני |
| **4** | **קטלוג המודלים** — סינק + טבלה + סינון (כולל `duration` ו-`end_frame`) + עמוד מודל + view הציונים | ממנו נגזרת בדיקת הנשיאוּת של שלב 3 | בינוני-גדול |
| **5** | **שיטות · מחקר · החלטות** | הידע קיים ברפו, חסר לו מסך | בינוני |
| **6** | **תצוגת חוץ** — שיתוף + מצגת + ניקוד-אורח | דורש עבודת אבטחה נפרדת | בינוני |

הערה על סדר: 4 לפני 3 היה נראה נכון, אבל בדיקת הנשיאוּת יכולה לקרוא בשלב 3 ישירות
מ-`shortlist-video.json` שבצד ה-Claude, ולעבור ל-`studio_models.arg_schema` בשלב 4.
כך שלב 3 לא חוסם.

---

## 13. סיכונים

| סיכון | טיפול |
|---|---|
| שבירת smrtVoice שעובד | **view לפני מיגרציה.** `studio_project_id` nullable, שני המסכים במקביל, אף שאילתה לא נשברת. שלב ד (טבלה מאוחדת) אופציונלי לנצח |
| שבירת מסך הניקוד | הקומפוננטה עוברת כמו-שהיא; `/plan/score` נשאר redirect |
| פרובננס מומצא לשורות ישנות | 🟡 ביושר, בלי השלמות מהזיכרון |
| רשימת שוטים שנחתכה למודל שהוחלף | `portable_to` מחושב מהסכמה; החלפת מודל מסמנת מיד את השוטים הלא-נשיאים |
| נכס שהוחלף ותוצרים תלויים בו | `studio_output_assets` + `superseded_by` → "מה צריך להיבנות מחדש" |
| כפילות רפו/DB | סינק חד-כיווני + `content_hash` |
| הסינק יישכח | GitHub Action |
| הקישור הציבורי חושף | סינון בשרת, טוקן חתום עם תפוגה, `revoked_at` |
| שדות שלא קיימים ב-fal | `arg_schema` מהסכמה המאומתת בלבד (כלל 5) |

**עלות:** הבנייה היא עבודת סוכן על המנוי — **אפס טוקני API בתשלום**, אין הרצות fal.
כל הרצה בתשלום בעתיד עוברת אישור-עלות נפרד.

---

## 14. הכרעות שנשארו לך

1. **עומק איחוד smrtVoice** — המלצה: **view-first** (שלבים א-ג), שלב ד רק אם יידרש.
   האלטרנטיבה (מיגרציה מלאה מיד) נקייה יותר אבל מסוכנת על דאטה חיה.
2. **`smrtvoice_projects` — נשאר או נבלע?** המלצה: **נשאר** כמכולת-הפקה של שלב הקול
   תחת `studio_projects`. הוא מחזיק שדות ייחודיים (Drive, מונה שורות, מצבי עיבוד).
3. **השם `smrtStudio`** — חלופות `smrtVideo` / `smrtFilm`. המלצה: **smrtStudio**
   (המערכת רחבה מווידאו).
4. **Backfill ההרצות והטייקים הקיימים** לפרוייקט + סבב? המלצה: **כן**.
5. **ניקוד-אורח בקישור הציבורי** — המלצה: **כבוי**, הפעלה פר-קישור.
6. **סבב מחקר = פרוייקט (`kind='research'`)?** המלצה: **כן** — רוב ההיקף עד כה הוא
   מחקר, וראוי שייספר.
7. **מאיזה שלב להתחיל** — המלצה: **0 + 0ב מיד** (קטנים, ומונעים נזק מצטבר).

---

## 15. איפה זה נוגע בקוד

| מה | קבצים |
|---|---|
| רישום | `supabase/migrations/<ts>_register_smrtstudio.sql`, `server/src/apps/smrtstudio/manifest.ts` |
| סכמה | `<ts>_smrtstudio_schema.sql`, `<ts>_outputs_provenance.sql`, `<ts>_studio_outputs_all_view.sql` |
| Backend | `server/src/modules/smrtstudio/{index,routes,catalog-sync,dashboard,provenance,shots,assets}.ts` |
| Frontend | `src/app/[locale]/(app)/(smrtstudio)/studio/**`, `src/components/smrtstudio/**` |
| מסך התוצרים | העברה מ-`src/components/smrtplan/ExperimentScoring.tsx` |
| צד הקול | `server/src/modules/smrtvoice/routes.ts` — כתיבת פרובננס בטייק |
| Panes · סייד-בר · i18n | `src/lib/panes/registry.tsx` · `Sidebar.tsx` · `src/messages/{he,en}.json` |
| רתמה | `video-lab/harness/{runner,store,backend}.py` |
| סינק | `video-lab/.github/workflows/sync-catalog.yml` |

**כללי הרפו:** `api()` בלבד · `requireApp("smrtstudio")` · i18n בשני הקבצים ·
פילטרים מקופלים כברירת מחדל · `h-full` ולא `100dvh` בתוך pane · `PaneLink` ·
**תאריכים בשעון ניו יורק** · לינקים עמוקים verbatim · `{ error }` על כל כתיבה.
