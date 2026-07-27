-- smrtStudio seed — the real state of the video program as of 2026-07-27.
--
-- Every row here is traceable to a source: a file in the video-lab repo, or a
-- query against experiment_runs / smrtvoice_*. Nothing is invented. Where a
-- number is not known it is left null rather than guessed.
--
-- Seeds ONLY into orgs entitled to smrtStudio (the core migration entitles the
-- orgs that already run the video program). A second tenant never inherits this
-- tenant's pipeline, notes or ledger.
--
-- Idempotent, and specific about what that means: stages, gates and challenges
-- upsert on a stable key and refresh ONLY the descriptive columns, so a `done`
-- or `solved` flag an operator toggled survives a re-run. The research index,
-- the ledger and the catalog carry no user state and are replaced wholesale —
-- scoped to the entitled orgs.

-- The orgs this seed applies to. Defined once as a temp view so every insert
-- below is scoped identically and no statement can drift.
create temporary view studio_orgs as
select o.id, o.created_by
from public.organizations o
join public.app_memberships m on m.org_id = o.id
join public.apps a on a.id = m.app_id and a.slug = 'smrtstudio';

-- 1. stages --------------------------------------------------------------------
insert into public.studio_stages
  (org_id, slug, position, name_he, name_en, blurb_he, blurb_en, hue,
   activity, decision_state, note_he, note_en)
select o.id, s.slug, s.position, s.name_he, s.name_en, s.blurb_he, s.blurb_en, s.hue,
       s.activity, s.decision_state, s.note_he, s.note_en
from studio_orgs o
cross join (values
 ('research', 1,'מחקר','Research',
  'נושא הפרק, המקורות, מה רוצים ללמד','Episode topic, sources, what it should teach',
  210,'idle','none','טרם התחיל.','Not started.'),
 ('script',   2,'תסריט','Script',
  'מה קורה בפרק, בשתי שפות','What happens in the episode, in two languages',
  255,'idle','none','טרם התחיל.','Not started.'),
 ('chars',    3,'דמויות','Characters',
  'בניית הדמויות — מוצלחות, ולא נראות AI','Building characters that work and never read as AI',
  275,'scoring','none','61 תוצרים ממתינים לניקוד. אף מודל לא הוכרע.',
  '61 outputs awaiting scoring. No model settled.'),
 ('voice',    4,'קולות','Voices',
  'הקלטות טבעיות בשתי שפות','Natural narration in two languages',
  175,'running','testing','80% מהדרך לצליל טבעי. נשאר היגוי ורגש.',
  '80% of the way to natural sound. Pronunciation and emotion remain.'),
 ('sets',     5,'רקעים ופריטים','Sets & props',
  'מקומות וחפצים — נבנים פעם אחת ונעולים','Places and objects — built once, then locked',
  145,'idle','none','טרם הורץ.','Not run yet.'),
 ('frames',   6,'פריימים','Frames',
  'פריים לכל שוט, מהדמויות והרקעים','One frame per shot, from the characters and sets',
  38,'research','none','במחקר. טרם הורץ.','In research. Not run yet.'),
 ('motion',   7,'תנועה','Motion',
  'הפיכת הפריימים לקליפים','Turning frames into clips',
  22,'research','none','במחקר ובדיקה. אפס הרצות — הפער הגדול בתוכנית.',
  'In research. Zero runs — the biggest gap in the program.'),
 ('lipsync',  8,'ליפסינק רב-לשוני','Multilingual lip-sync',
  'קליפ אחד → כל שפה. זו הכפולה','One clip, every language. This is the multiplier',
  335,'research','none','במחקר. הקליפ מופק פעם אחת והליפסינק רץ פר שפה.',
  'In research. The clip is produced once and lip-sync runs per language.'),
 ('assembly', 9,'הרכבה','Assembly',
  'חיבור, מוזיקה, שכבות טקסט','Cutting, music, text layers',
  190,'idle','none','טרם.','Not started.'),
 ('market',  10,'שיווק','Distribution',
  'קהל היעד, הכלים היעילים, עלות מול תפוצה','Audience, effective channels, cost vs reach',
  95,'idle','none','טרם.','Not started.')
) as s(slug, position, name_he, name_en, blurb_he, blurb_en, hue,
       activity, decision_state, note_he, note_en)
on conflict (org_id, slug) do update set
  position = excluded.position, name_he = excluded.name_he, name_en = excluded.name_en,
  blurb_he = excluded.blurb_he, blurb_en = excluded.blurb_en, hue = excluded.hue,
  note_he = excluded.note_he, note_en = excluded.note_en;

-- 2. gates ---------------------------------------------------------------------
-- The wording is content and is refreshed on every run; the `done` flag is
-- operator state and is written on INSERT only. The flags below are the state
-- as of the seed date — what has genuinely been completed.
insert into public.studio_gates (org_id, stage_slug, position, label_he, label_en, done)
select o.id, g.stage_slug, g.position, g.label_he, g.label_en, g.done
from studio_orgs o
cross join (values
 ('research',1,'להגדיר מאילו מקורות נחקר נושא','Define the sources a topic is researched from',false),
 ('research',2,'לאשר תקציר פרק','Approve an episode brief',false),

 ('script',1,'טיוטה מאושרת בשתי שפות','Approved draft in both languages',false),
 ('script',2,'משך יעד לכל סצנה','Target duration per scene',false),
 ('script',3,'מעבר בטיחות תוכן','Content-safety pass',false),

 ('chars',1,'משקולות ננעלו לפני שנראו תוצאות','Weights locked before any result was seen',true),
 ('chars',2,'אותו רפרנס ואותו seed לכל המודלים','Same reference and seed across all models',true),
 ('chars',3,'לנקד את כל 61 המועמדים — ניקוד עיוור','Score all 61 candidates — blind',false),
 ('chars',4,'לעבור את רף העקביות','Clear the consistency threshold',false),
 ('chars',5,'שיפוט אנושי: לא נראה כמו AI','Human verdict: does not read as AI',false),
 ('chars',6,'לנעול רפרנס קנוני לכל דמות','Lock one canonical reference per character',false),
 ('chars',7,'להשלים עלות ל-20 הרצות','Backfill cost for 20 runs',false),

 ('voice',1,'בסיס טבעי עובד','Natural baseline works',true),
 ('voice',2,'להכריע בין המודלים המתחרים','Decide between the competing models',false),
 ('voice',3,'לקסיקון מכסה את שמות הפרק','Lexicon covers the episode names',false),
 ('voice',4,'רגש מתקבל על מדגם','Emotion acceptable on a sample set',false),
 ('voice',5,'לנעול פרופיל קול לכל דמות','Lock a voice profile per character',false),
 ('voice',6,'לאשר אחוז סף של טייקים','Approve a threshold share of takes',false),

 ('sets',1,'להחליט אם מודדים עקביות מקום','Decide whether location consistency is measured',false),
 ('sets',2,'לנעול רפרנס לכל מקום','Lock one reference per location',false),
 ('sets',3,'לנקד מועמדים','Score the candidates',false),

 ('frames',1,'הוחלט: זוג פריימים כשהמודל תומך','Decided: frame pairs where the model supports it',true),
 ('frames',2,'להוכיח ששרשור באמת שומר זהות','Prove chaining actually preserves identity',false),
 ('frames',3,'עלות לפריים בתוך התקציב','Cost per frame within budget',false),

 ('motion',1,'כל היכולות אומתו מול המפרט','Every capability verified against the official spec',true),
 ('motion',2,'להריץ 6 מועמדים על אותן פעימות','Run all 6 candidates on the same beats',false),
 ('motion',3,'לנקד עקביות · תנועה · איכות','Score consistency, motion and quality',false),
 ('motion',4,'מדד גמישות חיתוך','Cut-flexibility criterion',false),
 ('motion',5,'מדד שמירת זהות בתנועה','Identity-in-motion criterion',false),
 ('motion',6,'לאמת את פער הרפרנס של Seedance','Verify the Seedance reference gap',false),
 ('motion',7,'עלות לשנייה מוגמרת בתוך התקציב','Cost per finished second within budget',false),

 ('lipsync',1,'להוכיח עברית — בדיקה עיוורת על כל השישה','Prove Hebrew — blind test across all six',false),
 ('lipsync',2,'לבחור משפחה: אווטאר או תיקון-פה','Pick a family: avatar or mouth-fix',false),
 ('lipsync',3,'להוכיח שפה שלישית','Prove a third language',false),
 ('lipsync',4,'עלות לדקה לכל שפה','Cost per minute per language',false),

 ('assembly',1,'להחליט איפה נוסף טקסט עברי','Decide where Hebrew on-screen text is added',false),
 ('assembly',2,'שתי שפות מאותו פס וידאו','Two languages from one video track',false),

 ('market',1,'להגדיר את הקהל','Define the audience',false),
 ('market',2,'לבחור ערוצים','Pick the channels',false),
 ('market',3,'יעד עלות לצפייה','Set a cost-per-view target',false)
) as g(stage_slug, position, label_he, label_en, done)
on conflict (org_id, stage_slug, position) do update set
  label_he = excluded.label_he, label_en = excluded.label_en;
  -- `done` is deliberately NOT in the update list: it is operator state.

-- 3. challenges ----------------------------------------------------------------
insert into public.studio_challenges
  (org_id, stage_slug, position, kind, title_he, title_en, solved, detail_he, detail_en)
select o.id, c.stage_slug, c.position, c.kind, c.title_he, c.title_en, c.solved,
       c.detail_he, c.detail_en
from studio_orgs o
cross join (values
 ('research',1,'expected','עוד לא הוגדר תהליך','No process defined yet',false,
  'מה נחקר לפני כתיבת פרק, ומאיזה מקורות','What gets researched before writing, and from which sources'),

 ('script',1,'expected','משפט עברי ואנגלי אינם באותו אורך','Hebrew and English lines differ in length',false,
  'ישפיע על חיתוך השוטים','It will affect how shots are cut'),

 ('chars',1,'expected','שהדמות לא תיראה כמו AI','The character must not read as AI',false,
  'המטרה המרכזית של השלב. 61 מועמדים הופקו, טרם נוקדו',
  'The central goal of this stage. 61 candidates produced, none scored yet'),
 ('chars',2,'expected','דמות שנראית מעט אחרת בכל תמונה','The character drifts between images',false,
  '5 שיטות עיגון נוסו; ההכרעה תלויה בניקוד',
  'Five anchoring methods tried; the verdict depends on scoring'),
 ('chars',3,'expected','איך משווים בין מודלים בהוגנות','How to compare models fairly',true,
  'אותה תמונת-ייחוס ואותו seed לכל המודלים, ומשקולות שננעלו לפני שנראתה תוצאה אחת',
  'Same reference image and seed for every model, with weights locked before a single result was seen'),
 ('chars',4,'hit','המדד האוטומטי מדד את השאלה הלא נכונה','The automatic metric measured the wrong question',true,
  'CLIP/DINO מחזירים מספר אחד שמערבב זהות + פוזה + רקע, ולכן יורדים דווקא כשהעבודה נכונה. פוצל לשלוש שאלות עם מדד נפרד; StyleID (0.902 על דמויות מסוגננות) במקום CLIP (0.256)',
  'CLIP/DINO return one number mixing identity + pose + background, so the score drops precisely when the work is right. Split into three separate questions; StyleID (0.902 on stylized faces) replaces CLIP (0.256)'),
 ('chars',5,'hit','המודל היקר ביותר קיבל את הציון הנמוך ביותר','The most expensive model scored lowest',false,
  'בשני מנועי מדידה בלתי תלויים: FLUX≈Qwen > Seedream > NB2 > Nano Banana Pro. ההכרעה עוברת לניקוד אנושי',
  'On two independent measurement backends: FLUX≈Qwen > Seedream > NB2 > Nano Banana Pro. The verdict moves to human scoring'),
 ('chars',6,'hit','מודל שהורץ ואינו ברשימה המדורגת','A model was run without being on the ranked list',true,
  'qwen-image-edit הורץ 10 פעמים. נכלל בציונים; שכבת הפרובננס תחייב רישום מראש',
  'qwen-image-edit ran 10 times. Included in the scores; the provenance layer will require registering up front'),
 ('chars',7,'hit','רקע שנסחף לגוון חמים','Background drifted to a warm tone',true,
  'זוהה ב-Kontext ותועד כהערה על כל שוט מושפע',
  'Spotted on Kontext and recorded as a note on every affected shot'),
 ('chars',8,'hit','20 מתוך 61 הרצות בלי עלות רשומה','20 of 61 runs recorded no cost',false,
  'qwen ו-nano-banana-2 — פער תיעוד שנסגר בשכבת הפרובננס',
  'qwen and nano-banana-2 — a documentation gap the provenance layer closes'),

 ('voice',1,'expected','שהקול יישמע טבעי','The voice must sound natural',true,
  '80% מהדרך — הבסיס עובד','80% of the way — the baseline works'),
 ('voice',2,'expected','היגוי','Pronunciation',false,
  'המילון מכיל 2 ערכים בלבד. הפער העיקרי','The lexicon holds only 2 entries. The main gap'),
 ('voice',3,'expected','רגש','Emotion',false,
  'הטייקים נשמעים שטוחים מדי בחלק מהשורות','Takes sound too flat on some lines'),
 ('voice',4,'expected','השירות לא נסגר','The service is not settled',false,
  '8 טייקים אושרו מתוך 264','8 takes approved out of 264'),
 ('voice',5,'hit','איך כופים הברה חב"דית','How to force the Chabad pronunciation',true,
  'שתי דרכים עובדות: IPA בשורה וכתיב פונטי. בפאנל 01 יצאו נכון שאבעס · דרב׳ה · דוקא · בייס',
  'Two methods work: inline IPA and phonetic spelling. Panel 01 produced the target words correctly'),
 ('voice',6,'hit','מילון ההגייה לא ניכר בהחזר','The pronunciation dictionary left no trace',false,
  'אותה שורה חזרה מהתמלול זהה למקור — המילון לא שינה הגייה בפועל',
  'The transcription came back identical to the source — the dictionary changed nothing in practice'),
 ('voice',7,'hit','תגי מבטא לא עשו כלום','Accent tags did nothing',false,
  'תג ישראלי ותג יידישאי — שניהם חזרו זהים למקור',
  'An Israeli tag and a Yiddish tag both came back identical to the source'),
 ('voice',8,'hit','הכתיב הפונטי גם משבש','Phonetic spelling also garbles',false,
  'מילת יעד אחת יצאה משובשת, וניקוד מלא קטע מילים',
  'One target word came out garbled, and full vocalization truncated words'),
 ('voice',9,'hit','מודל גיבוי זול החזיר טקסט שאינו עברית','A cheap fallback returned non-Hebrew text',true,
  'נפסל מהרשימה על סמך בדיקת-ההחזר','Dropped from the list on the read-back check'),

 ('sets',1,'expected','מקום שמשתנה בין שוטים','Locations drift between shots',false,
  'לא נמדד היום כלל — נבחן אם להוסיף מדד','Not measured at all today — an added metric is under consideration'),
 ('sets',2,'expected','רפרנס מקום ופריט נתמך אחרת בכל כלי','Place and prop references differ per tool',false,
  'נבדק מול הסכמות; טרם הוכרע','Checked against the schemas; not settled'),

 ('frames',1,'expected','חלק מכלי התנועה דורשים גם תמונת סיום','Some motion tools also need an end frame',true,
  'מפיקים זוג פריימים; הסיום של שוט הוא הפתיחה של הבא',
  'Produce a frame pair; a shot''s end frame is the next shot''s opening'),
 ('frames',2,'expected','עלות כפולה לכל שוט','Double the cost per shot',false,
  'שרשור חוסך כמעט חצי — טרם נבדק בפועל','Chaining saves nearly half — not yet tested in practice'),

 ('motion',1,'expected','לכל כלי אורכי קליפ אחרים','Every tool allows different clip lengths',true,
  'התכנון נכתב פעם אחת והחיתוך נגזר אוטומטית לכל כלי',
  'The plan is written once and the cut is derived automatically per tool'),
 ('motion',2,'expected','פער בין מה שמפרסמים ליכולת האמיתית','A gap between marketing and real capability',true,
  'כל יכולת מאומתת מול המפרט הרשמי לפני שמסתמכים עליה',
  'Every capability is verified against the official spec before being relied on'),
 ('motion',3,'expected','5 מ-6 הכלים בלי אמצעי לשמור על הדמות בתנועה','5 of 6 tools have no way to hold the character in motion',false,
  'הסיכון המרכזי בשלב','The central risk of this stage'),
 ('motion',4,'expected','הפרש של פי 7 בעלות בין הכלים','A 7× cost spread between tools',false,
  'ההכרעה תלויה באיזון איכות מול עלות','The verdict depends on balancing quality against cost'),
 ('motion',5,'hit','ברירת המחדל של LTX נלחמת בסדרה שלנו','LTX''s default fights our series',true,
  'הפרומפט השלילי המובנה פוסל במפורש "3d animation, cartoon, childish" — בדיוק הלוק שלנו. נכתבה דריסה קבועה',
  'Its built-in negative prompt explicitly rejects "3d animation, cartoon, childish" — exactly our look. A permanent override was written'),
 ('motion',6,'hit','הרחבת-פרומפט אוטומטית דלוקה כברירת מחדל','Automatic prompt expansion is on by default',true,
  'המודל מרחיב את הפרומפט לפני הגנרציה. מכובה בהשוואות, אחרת מודדים את המרחיב',
  'The model rewrites our prompt before generating. Turned off in comparisons, otherwise we measure the rewriter'),
 ('motion',7,'hit','הכללה שגויה על קלט אודיו','A wrong generalization about audio input',true,
  'נטען שאף מודל לא מקבל את האודיו שלנו. סריקת כל 513 נקודות-הקצה מצאה 70 שכן. הבדיקה עברה לרמת נקודת-קצה, לא מודל',
  'It was claimed no model accepts our audio. Scanning all 513 endpoints found 70 that do. The check moved to endpoint level, not model level'),
 ('motion',8,'hit','שדה בשם audio_url שהוא מוזיקת רקע','A field named audio_url that is background music',true,
  'השדה מדביק אודיו ואינו מסנכרן שפתיים. הסיווג נעשה לפי תיאור השדה, לא שמו',
  'The field muxes audio and does not sync lips. Classification is done by the field''s description, not its name'),
 ('motion',9,'hit','אין ולו הרצת וידאו אחת','Not a single video run',false,
  'אפס תוצרים בשלב. הפער הגדול ביותר בתוכנית','Zero outputs. The single biggest gap in the program'),

 ('lipsync',1,'expected','אף מודל לא מפרסם תמיכה בעברית','No model advertises Hebrew support',false,
  'כל ששת המתכונים נושאים את האזהרה','All six recipes carry the warning'),
 ('lipsync',2,'expected','שתי משפחות במקומות שונים בצינור','Two families sit at different points in the pipeline',false,
  'אווטאר מדלג על שלב התנועה; תיקון-פה בא אחריה',
  'Avatar skips the motion stage; mouth-fix comes after it'),
 ('lipsync',3,'expected','איך מגיעים להרבה שפות בלי להפיק מחדש','How to reach many languages without re-producing',true,
  'הווידאו מופק פעם אחת והליפסינק רץ פר שפה','The video is produced once and lip-sync runs per language'),
 ('lipsync',4,'hit','אותו מודל, שתי נקודות-קצה, חוזה שונה','Same model, two endpoints, entirely different contracts',true,
  'לאחת אין קלט אודיו ולשנייה יש. הכלל שנקבע: בודקים כל נקודת-קצה בנפרד',
  'One has no audio input and the other does. The rule set: every endpoint is checked separately'),

 ('assembly',1,'expected','טקסט עברי על המסך','Hebrew on-screen text',false,
  'הכלים לא מייצרים עברית אמינה — יתווסף בעריכה',
  'The tools do not render reliable Hebrew — it gets added in editing'),

 ('market',1,'expected','לא ידוע מי בדיוק הקהל ואיפה הוא','The audience is not yet defined',false,
  'נדרש מחקר מעמיק על קהל היעד','A deep audience study is required'),
 ('market',2,'expected','עלות מול תפוצה','Cost versus reach',false,
  'אילו ערוצים מחזירים הכי הרבה צפייה לשקל','Which channels return the most views per shekel')
) as c(stage_slug, position, kind, title_he, title_en, solved, detail_he, detail_en)
on conflict (org_id, stage_slug, kind, position) do update set
  title_he = excluded.title_he, title_en = excluded.title_en,
  detail_he = excluded.detail_he, detail_en = excluded.detail_en;
  -- `solved` is deliberately NOT updated: it is operator state.

-- 4. research index -------------------------------------------------------------
delete from public.studio_research where org_id in (select id from studio_orgs);

insert into public.studio_research
  (org_id, stage_slug, position, title_he, title_en, decides_he, decides_en,
   sources, repo, verified_at, status)
select o.id, r.stage_slug, r.position, r.title_he, r.title_en, r.decides_he, r.decides_en,
       r.sources, r.repo, r.verified_at::date, r.status
from studio_orgs o
cross join (values
 ('script',1,'תיאור הסדרה','Series bible',
  'הדמויות, העולם, הטון — הבסיס שכל תסריט נכתב מולו',
  'Characters, world and tone — what every script is written against',
  'docs/series.md','video-lab','2026-07-26','locked'),

 ('chars',1,'תזכיר בחירת מודלים — תמונות','Model selection memo — images',
  '6 מודלים מדורגים + 2 חלופות: מחיר, חוזק ושיטת עיגון לכל אחד',
  'Six ranked models plus two alternates: price, strength and anchoring method for each',
  'docs/models/prices-memo.md · docs/models/shortlist-image.json','video-lab','2026-07-23','locked'),
 ('chars',2,'שישה מתכוני מודל תמונה','Six image-model recipes',
  'שיטת הזנה, מבנה פרומפט ורזולוציה — כל שדה מאומת מול הסכמה הרשמית',
  'Input method, prompt structure and resolution — every field verified against the official schema',
  'docs/models/nano-banana-pro.md · nano-banana-2.md · flux-kontext-max.md · flux-kontext-pro.md · flux-2-pro.md · seedream-v5-pro-edit.md',
  'video-lab','2026-07-23','locked'),
 ('chars',3,'מבני פרומפט','Prompt formats',
  '18 מודלים, תחביר שונה לכל אחד: Kontext אוסר כינויי גוף, Nano Banana אוסר רשימת מילות-מפתח, FLUX.2 אינו תומך בפרומפט שלילי',
  '18 models, a different syntax each: Kontext forbids pronouns, Nano Banana forbids keyword lists, FLUX.2 supports no negative prompt at all',
  'docs/models/prompt-formats.json','video-lab','2026-07-24','locked'),
 ('chars',4,'קריטריונים ורף מעבר','Criteria and pass threshold',
  'המשקולות — ננעלו לפני שנראתה תוצאה אחת',
  'The weights — locked before a single result was seen',
  'docs/criteria.md','video-lab','2026-07-24','locked'),
 ('chars',5,'ציוני עקביות שחושבו בפועל','Consistency scores actually computed',
  'DINOv2 + CLIP-I על 5 מודלים × 2 דמויות × 10 תצוגות; שני המנועים נתנו אותו דירוג',
  'DINOv2 + CLIP-I across 5 models × 2 characters × 10 views; both backends produced the same ranking',
  'docs/assets/char-sheet-scores.json','video-lab','2026-07-24','locked'),

 ('voice',1,'תזכיר מודלי קול','Voice model memo',
  'קולות ילדים, עברית ישראלית והברה חב"דית. רק 3 מודלים מצהירים על עברית בסכמה עצמה',
  'Child voices, Israeli Hebrew and Chabad pronunciation. Only three models declare Hebrew in the schema itself',
  'docs/models/voice-memo.md · docs/models/shortlist-voice.json','video-lab','2026-07-26','locked'),
 ('voice',2,'עשרה מתכוני קול','Ten voice recipes',
  'MiniMax ×3 · ElevenLabs ×2 · Gemini TTS · Maya · Chatterbox ×2',
  'MiniMax ×3 · ElevenLabs ×2 · Gemini TTS · Maya · Chatterbox ×2',
  'docs/models/minimax-*.md · elevenlabs-*.md · gemini-3.1-flash-tts.md · maya1.md · chatterbox*.md',
  'video-lab','2026-07-26','locked'),
 ('voice',3,'חוברת הגייה','Pronunciation playbook',
  'שלוש דרכים רשמיות לכפות הברה: מילון הגייה, IPA בשורה, והמרת-קול משומרת-מבטא',
  'Three official ways to force a pronunciation: a lexicon, inline IPA, and accent-preserving voice conversion',
  'docs/models/havara-playbook.md','video-lab','2026-07-26','locked'),
 ('voice',4,'פאנל קול 01','Voice panel 01',
  '13 הרצות בניקוד עיוור + בדיקת-החזר בתמלול אוטומטי',
  '13 blind-scored runs plus an automatic transcription read-back check',
  'docs/panels/voice-panel-01-readback.md · docs/panels/voice-panel-01.json','video-lab','2026-07-26','locked'),

 ('sets',1,'דקדוק שוט','Shot grammar',
  'תנועת מצלמה כפרמטר · רפרנס מקום ופריט · זוגות פריימים · רצף בין שוטים',
  'Camera movement as a parameter · place and prop references · frame pairs · continuity between shots',
  'docs/models/shot-grammar.json','video-lab','2026-07-25','locked'),
 ('frames',1,'דקדוק שוט','Shot grammar',
  'זוגות פריימים ורצף בין שוטים','Frame pairs and continuity between shots',
  'docs/models/shot-grammar.json','video-lab','2026-07-25','locked'),

 ('motion',1,'תזכיר בחירת מודלים — וידאו','Model selection memo — video',
  '6 מודלים מדורגים + 2 במעקב: מחיר לקליפ, חוזק, מגבלות',
  'Six ranked models plus two on the watch list: price per clip, strengths, limits',
  'docs/models/prices-memo.md · docs/models/shortlist-video.json','video-lab','2026-07-23','locked'),
 ('motion',2,'סריקת הקטלוג המלא','Full catalog sweep',
  '1,394 מודלים · 35 עמודי API · 513 נקודות-קצה וידאו — לכל אחת נמשכה סכמת ה-OpenAPI הרשמית',
  '1,394 models · 35 API pages · 513 video endpoints — the official OpenAPI schema pulled for every one',
  'docs/models/sub-research-2b.md §א','video-lab','2026-07-24','locked'),
 ('motion',3,'מי מקבל את האודיו שלנו','Which endpoints accept our audio',
  '70 מ-513 מקבלות קובץ אודיו · 139 רק מתג אודיו-פלט · שלוש מחלקות, כולל מלכודת "אודיו מודבק"',
  '70 of 513 accept an audio file · 139 only have an output-audio toggle · three classes, including a muxed-audio trap',
  'docs/models/shortlist-audio-input.json','video-lab','2026-07-24','locked'),
 ('motion',4,'תשעה מתכוני וידאו','Nine video recipes',
  'Kling ×2 · PixVerse · Seedance ×2 · Happy Horse · Veo 3.1 · Wan 2.7 · LTX-2.3',
  'Kling ×2 · PixVerse · Seedance ×2 · Happy Horse · Veo 3.1 · Wan 2.7 · LTX-2.3',
  'docs/models/*-i2v.md · ltx-2.3-audio-to-video.md · veo3.1.md','video-lab','2026-07-24','locked'),

 ('lipsync',1,'רשימת ליפסינק','Lip-sync shortlist',
  '6 מודלים בשתי משפחות: אווטאר (תמונה+אודיו) מול תיקון-פה (וידאו→וידאו)',
  'Six models in two families: avatar (image+audio) versus mouth-fix (video→video)',
  'docs/models/shortlist-lipsync.json','video-lab','2026-07-23','locked'),
 ('lipsync',2,'שישה מתכוני ליפסינק','Six lip-sync recipes',
  'Kling Avatar v2 · LatentSync · MuseTalk · Sync · OmniHuman 1.5 · VEED',
  'Kling Avatar v2 · LatentSync · MuseTalk · Sync · OmniHuman 1.5 · VEED',
  'docs/models/kling-ai-avatar-v2.md · latentsync.md · musetalk.md · sync-lipsync.md · omnihuman-v1.5.md · veed-lipsync-v2.md',
  'video-lab','2026-07-23','locked'),

 ('cross',1,'אינדקס המחקרים','Research index',
  'המסמך שמרכז את הכל — מה נחקר, איפה הוא יושב, ומה הוא מכריע',
  'The document that centralizes everything — what was researched, where it lives, what it decides',
  'docs/research-index.md','video-lab','2026-07-27','living'),
 ('cross',2,'רישוי ותנאי דאטה של הספקים','Vendor licensing and data terms',
  '42 מודלים — רישוי מסחרי נקי בכולם. 22 מהם proxy: הקלט עובר לספק חיצוני. דגל אדום על BFL — זכות בלתי-הפיכה על קלט ופלט, בלי opt-out',
  '42 models — commercial licensing clean across the board. 22 are proxied: our input leaves for a third party. Red flag on BFL — an irrevocable right over input and output, with no opt-out',
  'docs/models/vendor-checklist.json','video-lab','2026-07-25','locked'),
 ('cross',3,'בדיקת QC אוטומטית מול העין האנושית','Automatic QC versus the human eye',
  'המסקנה: מסננת ומדרג — לא פוסק. חלש במיוחד על דמויות מסוגננות ועל עברית',
  'The conclusion: a filter and a ranker — not a judge. Especially weak on stylized characters and on Hebrew',
  'docs/auto-qc-research.md','video-lab','2026-07-24','locked'),
 ('cross',4,'סטאק מדדי הבדיקה','The QC metric stack',
  'פירוק לשלוש שאלות נפרדות: זהות (StyleID) · פוזה (OKS) · רגרסיה (DreamSim) + שופט-VLM',
  'Split into three separate questions: identity (StyleID) · pose (OKS) · regression (DreamSim) plus a VLM judge',
  'docs/models/qc-models.json · docs/models/sub-research-2b.md §ג','video-lab','2026-07-24','locked'),
 ('cross',5,'מקביליות החשבון','Account concurrency',
  '2 בקשות במקביל, גדל עד 40. בקשות בתור לא נדחות',
  'Two concurrent requests, growing to 40. Queued requests are never rejected',
  'docs/models/concurrency.json','video-lab','2026-07-23','locked'),
 ('cross',6,'ביקורת התוכנית','Program audit',
  '79 ממצאים גולמיים → 21 מאושרים, כולם הוחלו',
  '79 raw findings → 21 confirmed, all applied',
  'docs/plan-v2-audit.md · docs/plan-v2-proposal.md','video-lab','2026-07-23','applied'),
 ('cross',7,'פרוטוקול תכנון פרויקט','Project planning protocol',
  '1,471 שורות: טריאז'', מחקר מונחה-השערה, מטריצת החלטה משוקללת, שערי איכות',
  '1,471 lines: triage, hypothesis-driven research, weighted decision matrix, quality gates',
  'docs/project-planning-protocol.md','mrtesy-app','2026-07-24','living'),
 ('cross',8,'פרוטוקול טרום-דחיפה','Pre-push protocol',
  'חמישה שלבים לפני שקוד נכנס, וסוכן-ביקורת שהוא השער',
  'Five steps before code lands, with a review agent as the gate',
  'docs/pre-push-protocol.md','mrtesy-app','2026-07-24','living'),
 ('cross',9,'מחקר גיוס','Hiring research',
  '529 שורות: סריקת שוק מוצלבת ממקורות עצמאיים, פרופיל התפקיד, מסלול טרייל ומדדי הצלחה',
  '529 lines: a market scan cross-checked across independent sources, the role profile, a trial track and success metrics',
  'docs/onlinejobs-marketing-hire-plan.md','mrtesy-app','2026-07-24','locked'),
 ('cross',10,'ניצול הזמן','Time utilization',
  'כלי היום (437 שורות) ושעון עבודה (290 שורות) — מכסה יומית, טקס בוקר, הגבלות מסלימות',
  'Day tools (437 lines) and the work clock (290 lines) — a daily quota, a morning ritual, escalating limits',
  'docs/day-tools-plan.md · docs/workclock-plan.md','mrtesy-app','2026-07-24','living'),
 ('cross',11,'תוכנית smrtStudio','The smrtStudio plan',
  'ההפרדה בין כוונה לתוכנית-רינדור, שני צירי מצב לשלב, חוזה הפרובננס ושכבת השקיפות',
  'Intent versus render plan, two axes of stage state, the provenance contract and the transparency layer',
  'docs/smrtstudio-plan.md','mrtesy-app','2026-07-27','living')
) as r(stage_slug, position, title_he, title_en, decides_he, decides_en,
       sources, repo, verified_at, status);

-- 5. investment -----------------------------------------------------------------
delete from public.studio_investment where org_id in (select id from studio_orgs);

insert into public.studio_investment
  (org_id, position, label_he, label_en, hours, value_usd, detail_he, detail_en, kind)
select o.id, i.position, i.label_he, i.label_en, i.hours, i.value_usd,
       i.detail_he, i.detail_en, i.kind
from studio_orgs o
cross join (values
 (1,'תכנון וארכיטקטורה','Planning and architecture',300,19210,
  'מבנה המערכת, הצינור, שיטת ההכרעה','System structure, the pipeline, the decision method','work'),
 (2,'בניית התשתית והכלים','Infrastructure and tooling',620,39700,
  'הפלטפורמה, מערכת הקול, מנוע ההרצות, הטרמינל',
  'The platform, the voice system, the run engine, the terminal','work'),
 (3,'מחקר ובחירת מודלים','Model research and selection',330,21130,
  '1,394 נסרקו · 513 נקודות-קצה · 42 מדורגים · 30 מתכונים',
  '1,394 scanned · 513 endpoints · 42 ranked · 30 recipes','work'),
 (4,'שיטות עבודה ומחקר תהליך','Working methods and process research',130,8325,
  '4,176 שורות פרוטוקול — תכנון, עבודת צוות, גיוס',
  '4,176 lines of protocol — planning, teamwork, hiring','work'),
 (5,'בדיקות והפקה','Testing and production',120,7683,
  '325 תוצרים הופקו ותועדו','325 outputs produced and documented','work'),
 (6,'הוצאה ישירה — שירותי AI','Direct spend — AI services',null,3.91,
  'תשלום בפועל שנרשם. ההוצאה האמיתית גבוהה מזה — חלק מההרצות המוקדמות לא רשמו עלות',
  'Actual recorded spend. True spend is higher — some early runs recorded no cost','direct'),
 -- The funding request. Held as data rather than hardcoded in the investor
 -- component so a second tenant never inherits this tenant's ask, and so the
 -- figure can only change by an explicit, recorded edit.
 (10,'היקף התוכנית המלא','Full program',null,450000,
  'הבקשה הכוללת','The total ask','ask_total'),
 (11,'תשלום ראשון','Tranche 1',null,150000,
  'להכריע את שלב התנועה ולנעול את הצינור',
  'Settle the motion stage and lock the pipeline','ask'),
 (12,'תשלום שני','Tranche 2',null,200000,
  'לבנות את מערכת ההפקה ולהריץ את הפיילוט',
  'Build the production system and run the pilot','ask'),
 (13,'תשלום שלישי','Tranche 3',null,100000,
  'להגיע לקצב שבועי בשתי שפות',
  'Reach a weekly cadence in two languages','ask')
) as i(position, label_he, label_en, hours, value_usd, detail_he, detail_en, kind);

-- 6. model catalog ---------------------------------------------------------------
-- The deep tier: every model that carries a written recipe and whose endpoint id
-- and input fields were verified against the official fal OpenAPI schema
-- (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`). That is
-- exactly what `verified_schema` asserts — it is NOT "fal lists it".
--
-- The auto-indexed shelf (the remaining ~1,350 models in the fal catalog) is
-- populated by an indexing run, not by this migration; until it runs the catalog
-- screen shows only this tier and says so.
delete from public.studio_models
 where org_id in (select id from studio_orgs) and verified_schema = true;

insert into public.studio_models
  (org_id, endpoint_id, title, kind, vendor, hosting_type, license_type,
   price_usd, price_unit, verified_schema, verified_at, shortlist_rank, recipe_path, source_url)
select o.id, m.endpoint_id, m.title, m.kind, m.vendor, m.hosting_type, 'commercial',
       m.price_usd, m.price_unit, true, m.verified_at::date, m.rank, m.recipe,
       'https://fal.ai/models/' || m.endpoint_id
from studio_orgs o
cross join (values
 -- images (shortlist-image.json)
 ('fal-ai/nano-banana-pro','Nano Banana Pro','image','Google','proxy',0.15,'image',1,'docs/models/nano-banana-pro.md','2026-07-23'),
 ('bytedance/seedream/v5/pro/edit','Seedream 5.0 Pro Edit','image','ByteDance','proxy',0.0675,'image (≤1536²)',2,'docs/models/seedream-v5-pro-edit.md','2026-07-23'),
 ('fal-ai/flux-pro/kontext/max','FLUX.1 Kontext [max]','image','Black Forest Labs','proxy',0.08,'image',3,'docs/models/flux-kontext-max.md','2026-07-23'),
 ('fal-ai/nano-banana-2','Nano Banana 2','image','Google','proxy',0.08,'image (1K)',4,'docs/models/nano-banana-2.md','2026-07-23'),
 ('fal-ai/flux-pro/kontext','FLUX.1 Kontext [pro]','image','Black Forest Labs','proxy',0.04,'image',5,'docs/models/flux-kontext-pro.md','2026-07-23'),
 ('fal-ai/flux-2-pro','FLUX.2 [pro]','image','Black Forest Labs','proxy',0.03,'megapixel',6,'docs/models/flux-2-pro.md','2026-07-23'),
 -- video / motion (shortlist-video.json + the audio-input sweep)
 ('fal-ai/kling-video/v2.5-turbo/pro/image-to-video','Kling 2.5 Turbo Pro (i2v)','video','Kuaishou','proxy',0.35,'clip (5s)',1,'docs/models/kling-v2.5-turbo-pro-i2v.md','2026-07-23'),
 ('fal-ai/pixverse/v6/image-to-video','PixVerse V6 (i2v)','video','PixVerse','proxy',0.225,'clip (5s @720p)',2,'docs/models/pixverse-v6-i2v.md','2026-07-23'),
 ('fal-ai/kling-video/v3/pro/image-to-video','Kling v3 Pro (i2v)','video','Kuaishou','proxy',0.56,'clip (5s, audio off)',3,'docs/models/kling-v3-pro-i2v.md','2026-07-23'),
 ('bytedance/seedance-2.0/image-to-video','Seedance 2.0 (i2v)','video','ByteDance','proxy',1.51,'clip (5s @720p)',4,'docs/models/seedance-2.0-i2v.md','2026-07-23'),
 ('alibaba/happy-horse/v1.1/image-to-video','Happy Horse 1.1 (i2v)','video','Alibaba','proxy',0.70,'clip (5s @720p)',5,'docs/models/happy-horse-v1.1-i2v.md','2026-07-23'),
 ('fal-ai/veo3.1/image-to-video','Veo 3.1 (i2v)','video','Google','proxy',0.50,'clip (5s Fast, audio off)',6,'docs/models/veo3.1.md','2026-07-23'),
 ('fal-ai/ltx-2.3-22b/audio-to-video','LTX-2.3 22B (audio-to-video)','video','Lightricks','serverless',0.28,'shot (8s)',7,'docs/models/ltx-2.3-audio-to-video.md','2026-07-24'),
 ('fal-ai/wan/v2.7/image-to-video','Wan 2.7 (i2v, driving audio)','video','Alibaba','proxy',0.80,'shot (8s @720p)',8,'docs/models/wan-2.7-i2v.md','2026-07-24'),
 ('bytedance/seedance-2.0/mini/reference-to-video','Seedance 2.0 mini (ref2v)','video','ByteDance','proxy',0.58,'shot (8s)',9,'docs/models/seedance-2.0-ref2v.md','2026-07-24'),
 -- lip-sync (shortlist-lipsync.json)
 ('fal-ai/kling-video/ai-avatar/v2/standard','Kling AI Avatar v2','lipsync','Kuaishou','proxy',0.0562,'second',1,'docs/models/kling-ai-avatar-v2.md','2026-07-23'),
 ('fal-ai/latentsync','LatentSync','lipsync','fal','serverless',0.20,'video up to 40s',2,'docs/models/latentsync.md','2026-07-23'),
 ('fal-ai/musetalk','MuseTalk','lipsync','fal','serverless',null,'compute second',3,'docs/models/musetalk.md','2026-07-23'),
 ('fal-ai/sync-lipsync/v2','Sync Lipsync v2','lipsync','Sync','proxy',3.00,'minute',4,'docs/models/sync-lipsync.md','2026-07-23'),
 ('fal-ai/bytedance/omnihuman/v1.5','OmniHuman 1.5','lipsync','ByteDance','proxy',0.16,'second',5,'docs/models/omnihuman-v1.5.md','2026-07-23'),
 ('veed/lipsync/v2','VEED Lipsync v2','lipsync','VEED','proxy',0.07,'second',6,'docs/models/veed-lipsync-v2.md','2026-07-23'),
 -- voice (shortlist-voice.json)
 ('fal-ai/minimax/speech-2.8-hd','MiniMax Speech 2.8 HD','voice','MiniMax','proxy',0.10,'1000 characters',1,'docs/models/minimax-speech-2.8-hd.md','2026-07-26'),
 ('fal-ai/minimax/voice-design','MiniMax Voice Design','voice','MiniMax','proxy',3.00,'voice',2,'docs/models/minimax-voice-design.md','2026-07-26'),
 ('fal-ai/minimax/voice-clone','MiniMax Voice Cloning','voice','MiniMax','proxy',1.50,'clone',3,'docs/models/minimax-voice-clone.md','2026-07-26'),
 ('fal-ai/elevenlabs/tts/eleven-v3','ElevenLabs TTS v3','voice','ElevenLabs','proxy',null,'characters',4,'docs/models/elevenlabs-tts-eleven-v3.md','2026-07-26'),
 ('fal-ai/elevenlabs/voice-changer','ElevenLabs Voice Changer','voice','ElevenLabs','proxy',0.30,'minute',5,'docs/models/elevenlabs-voice-changer.md','2026-07-26'),
 ('fal-ai/gemini-3.1-flash-tts','Gemini 3.1 Flash TTS','voice','Google','proxy',null,'characters',6,'docs/models/gemini-3.1-flash-tts.md','2026-07-26'),
 ('fal-ai/maya','Maya 1','voice','Maya','proxy',null,'second',7,'docs/models/maya1.md','2026-07-26'),
 ('fal-ai/chatterbox/multilingual','Chatterbox Multilingual','voice','Resemble','serverless',null,'second',8,'docs/models/chatterbox-multilingual.md','2026-07-26'),
 ('fal-ai/chatterboxhd/speech-to-speech','ChatterboxHD Speech-to-Speech','voice','Resemble','serverless',null,'second',9,'docs/models/chatterboxhd-speech-to-speech.md','2026-07-26'),
 -- QC (qc-models.json)
 ('fal-ai/elevenlabs/speech-to-text/scribe-v2','ElevenLabs Scribe v2 (read-back check)','qc','ElevenLabs','proxy',0.008,'input audio minute',1,'docs/models/qc-models.json','2026-07-26'),
 ('openrouter/router/vision','VLM judge via OpenRouter','qc','OpenRouter','proxy',0.001,'check',2,'docs/models/qc-models.json','2026-07-24')
) as m(endpoint_id, title, kind, vendor, hosting_type, price_usd, price_unit, rank, recipe, verified_at)
on conflict (org_id, endpoint_id) do update set
  title = excluded.title, kind = excluded.kind, vendor = excluded.vendor,
  hosting_type = excluded.hosting_type, price_usd = excluded.price_usd,
  price_unit = excluded.price_unit, verified_schema = excluded.verified_schema,
  verified_at = excluded.verified_at, shortlist_rank = excluded.shortlist_rank,
  recipe_path = excluded.recipe_path, source_url = excluded.source_url;
