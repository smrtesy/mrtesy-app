# מדריך מעבר: מ-Vimeo ל-Bunny Stream (מעודכן)

**המטרה:** כל הוידאו יישב תחת הדומיין שלך בלבד, זול ומהיר, עם תמיכת Cast —
וכל מה שהדפדפן רואה הוא הדומיין שלך, שום `bunny` / `b-cdn` / `mediadelivery`.
בנוסף: **רק מנויים** מקבלים ניגון ישיר (שער מנוי לפי אימייל), ו**אותם וידאו
עברית מתנגנים גם מהדומיין האנגלי** — בלי שכפול.

> עדכון מול הגרסה הראשונה: הדומיין של הבוט העברי הוא **`rebbek.org`** (לא
> maor.org). `maor.org` הוא הארגון/בעל חשבון ה-Bunny. הוידאו מוגש מ-
> **`video.rebbek.org`**, וגם מ-**`video.mymaor.org`** לאתר האנגלי.

---

## ארכיטקטורה בקצרה — שתי שכבות

1. **שער המנוי שלנו** (כבר בנוי בפלטפורמה) — קובע *מי מורשה*: זיהוי לפי אימייל
   → בדיקת מנוי מול המערכת החיצונית → טוקן חתום בלינק שהבוט שולח.
2. **Bunny + נגן white-label** (מוקם לפי המדריך הזה) — *אחסון, encoding,
   הזרמה והגנה מפני hot-linking*, הכל תחת הדומיין שלך.

```
הבוט שולח:  https://rebbek.org/<מספר_וידאו>[?t=<טוקן-מנוי>]
הדפדפן פותח (שורת כתובת: רק rebbek.org):
   צד-שרת של הדף:
     1. מאמת את הטוקן שלנו  → POST /api/smrtbot/playback/verify  → מנוי? וידאו? אימייל?
     2. אם מנוי → חותם directory-token של Bunny (צד-שרת) → מזריק את ה-m3u8 לנגן
     3. אחרת → אין URL חתום → התחברות/הרשמה
   הנגן (היברידי, בלי דומיין צד-שלישי):
     Safari/iOS  → <video src=m3u8> נייטיב   (AirPlay עובד)
     כרום/אנדרואיד → hls.js                    (Chromecast עובד)
   ה-HLS מגיע מ-video.rebbek.org (CNAME ל-Bunny)
```

---

## חלק 1 — חלוקת עבודה

| אתה (ידני, dashboards) | הפלטפורמה / הריפו הזה | צד האתר (rebbek.org / mymaor.org) |
|---|---|---|
| חשבון Bunny + Library | שער המנוי + endpoint אימות טוקן | הנגן ההיברידי (hls.js + נייטיב) |
| custom hostnames + DNS + SSL | הטוקן בלינק שהבוט שולח | חתימת directory-token של Bunny (צד-שרת) |
| allowed domains ל-Cast | מטא-דאטה + GUID ב-Supabase | הטמעת הנגן + עדכון קישורים מ-Vimeo לנגן החדש |
| השגת המפתחות | הרצת vimeo2bunny (אפשר מהריפו) | בדיקת Network tab |

> הנגן עצמו נבנה **בצד האתר** (rebbek.org הוא קוד נפרד). הפלטפורמה מספקת שער,
> טוקן, endpoint ומטא-דאטה. אפשר לקבל קובץ נגן היברידי + חתימת Bunny מוכן-להטמעה.

---

## חלק 2 — צעדים ידניים ב-Bunny (≈20 דק')

### שלב א — חשבון
1. הירשם ב-`bunny.net`, הוסף אמצעי תשלום (pay-as-you-go).

### שלב ב — Stream Library אחד
1. `Stream` ← `Add Video Library`. שם: למשל `maor-videos-he`.
2. בחר **multi-region replication** (ארה"ב, אירופה, אסיה) לקהל גלובלי.
3. **Library אחד מספיק לכל הדומיינים שמנגנים את אותם וידאו.** Library נוסף רק אם
   יהיה תוכן *שונה* (למשל סרטונים אנגליים ייעודיים).

### שלב ג — custom hostnames (הלב של ה-white-label)
ב-Pull Zone של ה-Library (`API` ← Pull Zone ← `Manage` ← `Hostnames`) הוסף **שני**
hostnames לאותו zone:
1. **`video.rebbek.org`** (לאתר העברי)
2. **`video.mymaor.org`** (לאתר האנגלי — מנגן את אותם וידאו עברית)

לכל אחד:
- Bunny ייתן ערך CNAME (כמו `vz-xxxx.b-cdn.net`) — העתק.
- ב-DNS (Cloudflare) של הדומיין המתאים הוסף רשומת CNAME: Name=`video`, Target=הערך מ-Bunny.
- **⚠️ קריטי:** כבה את ה-proxy של Cloudflare (עננה כתומה → אפורה). אם דלוקה — **לא יעבוד**.
- ב-Bunny לחץ `Verify & Activate SSL`.

> אותו GUID מתנגן תחת שני ה-hostnames. כל אתר רואה רק את הדומיין שלו. אפס שכפול.

### שלב ד — Cast (אל תדלג)
ב-`Security` של ה-Library, ל-allowed domains הוסף: **`rebbek.org`** ו-**`mymaor.org`**
(וכל דומיין נוסף שמנגן). זה מונע שנעילת הדומיין תשבור Chromecast. AirPlay עובד גם בלי.

### שלב ה — Token Authentication
1. ב-`Security` הפעל **Token Authentication** ושמור את ה-**Token Key** (זה ה-`BUNNY_TOKEN_KEY`).
2. השתמש ב-**directory token** (מאשר את כל נתיב ה-HLS — חובה לסגמנטים, ועובד גם עם נייטיב ל-AirPlay).
3. **אל תנעל ל-IP** — מכשיר ה-Cast מושך מ-IP שונה; נעילת IP תשבור Casting.
4. החתימה תמיד **בצד-שרת** (המפתח סודי).

### שלב ו — המפתחות (ל-`.env`, לא בצ'אט)
- **Bunny Library ID** (`API` של ה-Library)
- **Bunny API Key** (לכלי המיגרציה)
- **Bunny Token Key** (משלב ה)
- **Vimeo Access Token** (חלק 3)

---

## חלק 3 — Token של Vimeo
1. Vimeo Developer Portal ← `Create an app`. בשם **אל תכלול "Vimeo"**.
2. "Will people besides you access your app?" → `No` → `Create App`.
3. `Authentication` ← `Generate an access token` ← `Authenticated (you)` עם הרשאות read/video files → `Generate` → העתק.

---

## חלק 4 — ההעברה (vimeo2bunny דרך npx)
```
npx vimeo2bunny list                 # מה יש בוימאו
npx vimeo2bunny migrate --dry-run    # תצוגה מקדימה, לא משנה כלום
npx vimeo2bunny migrate              # ההעברה האמיתית
npx vimeo2bunny migrate --folder <id>        # תיקייה ספציפית
npx vimeo2bunny migrate --concurrency 5      # האצה (מקס' 20)
npx vimeo2bunny migrate --resume             # חידוש שנקטע
npx vimeo2bunny status
```
**תמיד `--dry-run` קודם.** המיגרציה רצה מול **Library אחד** (Hebrew) — לא צריך
להריץ אותה פעמיים בשביל הדומיין האנגלי, כי שני ה-hostnames מצביעים לאותו Library.

---

## חלק 5 — תצורה בפלטפורמה (per-bot)

כל בוט/דומיין מחזיק תצורה משלו. **לא-סודי** → `smrtbot_settings` (key/value פר בוט);
**סודי** → `app_secrets` (Vault, דרך ה-admin UI).

### הבוט העברי (rebbek.org)
`smrtbot_settings`:
| key | value |
|---|---|
| `VIDEO_WATCH_BASE_URL` | `https://rebbek.org` |
| `SUBSCRIPTION_API_BASE_URL` | `https://rebbek.org` (או כתובת מערכת המנויים) |
| `VIDEO_OTP_FROM_EMAIL` | `noreply@rebbek.org` |
| `VIDEO_OTP_SES_REGION` | האזור שלך (למשל `eu-west-1`) |
| `BUNNY_LIBRARY_ID` | מזהה ה-Library העברי |
| `BUNNY_CDN_HOSTNAME` | `video.rebbek.org` |

### הבוט האנגלי (mymaor.org) — אותם וידאו
| key | value |
|---|---|
| `VIDEO_WATCH_BASE_URL` | `https://mymaor.org` |
| `BUNNY_LIBRARY_ID` | **אותו Library** כמו rebbek ← זה מה שמשתף את הוידאו |
| `BUNNY_CDN_HOSTNAME` | `video.mymaor.org` |
| (שאר המפתחות לפי הצורך) | |

### סודות (`app_secrets`, slug `smrtbot`, Vault)
| key | scope |
|---|---|
| `SUBSCRIPTION_API_SECRET` | פר-בוט/גלובלי |
| `BUNNY_TOKEN_KEY` | פר-בוט (מפתח ה-Token של ה-Library) |
| `VIDEO_TOKEN_SECRET` | פלטפורמה (חתימת הטוקן שלנו) |
| `VIDEO_VERIFY_SECRET` | פלטפורמה (Bearer שהאתר שולח ל-endpoint האימות שלנו) |

> כל עוד `VIDEO_WATCH_BASE_URL` והמנוי לא מוגדרים — הבוט מתנהג כמו היום (לינקים גולמיים).

---

## חלק 6 — אחרי ההעברה
1. צד האתר בונה את הנגן ההיברידי שטוען מ-`video.rebbek.org` / `video.mymaor.org`.
2. שומרים את ה-**GUID** של כל וידאו ב-`smrtbot_videos.bunny_video_guid` (קישור בין הוידאו ב-Bunny לקטלוג שלנו). הקטלוג ברמת הארגון — משותף לשני הדומיינים.
3. מעדכנים את הקישורים מ-Vimeo לנגן החדש.
4. **בדיקה סופית:** Network tab → ודא שכל הבקשות הן ל-`video.rebbek.org` (או `video.mymaor.org`) בלבד. נסה Cast לטלוויזיה (Chromecast + AirPlay).
5. רק אחרי שהכל עובד — מבטלים את Vimeo.

---

## ריכוז דומיינים
| תפקיד | דומיין |
|---|---|
| ארגון / בעל חשבון Bunny | `maor.org` |
| בוט עברי (דף הצפייה) | `rebbek.org` → CDN `video.rebbek.org` |
| דומיין אנגלי (אותם וידאו) | `mymaor.org` → CDN `video.mymaor.org` |

**חשבון Bunny אחד, Library אחד, שני hostnames.** חשבון/Library נפרד רק אם יידרש
חיוב נפרד או תוכן שונה.
