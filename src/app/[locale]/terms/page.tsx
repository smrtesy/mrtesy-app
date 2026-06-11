import Link from "next/link";

const EFFECTIVE_DATE = "June 11, 2025";
const CONTACT_EMAIL = "support@smrtesy.com";

const heContent = {
  title: "תנאי שימוש",
  lastUpdated: `עודכן לאחרונה: 11 ביוני 2025`,
  sections: [
    {
      heading: "1. קבלת התנאים",
      body: `השימוש בשירות smrtesy מהווה הסכמה לתנאים אלה. אם אינכם מסכימים, אנא הפסיקו את השימוש. השירות מיועד לבני 18 ומעלה.`,
    },
    {
      heading: "2. תיאור השירות",
      body: `smrtesy הוא כלי AI אישי שפותח על ידי מאור, המסייע בניהול משימות, עיבוד מיילים, תזמון ויצירת תובנות. השירות מסופק "כמות שהוא" (AS IS).`,
    },
    {
      heading: "3. גישה מוגבלת — שירות בהזמנה בלבד",
      body: `השירות אינו פתוח לציבור הרחב. גישה לשירות מותרת אך ורק למשתמשים שקיבלו הזמנה מפורשת ממאור, או שהם חברים בארגון המנוי לשירות. שימוש ללא הזמנה תקפה אסור ומהווה הפרה של תנאים אלה.`,
    },
    {
      heading: "4. חשבון משתמש",
      body: `• אתם אחראים לשמירת פרטי הגישה לחשבונכם.
• חל איסור על שיתוף חשבון עם אחרים.
• עליכם לדווח מיידית על כל שימוש לא מורשה בחשבונכם.
• אנו שומרים את הזכות להשעות חשבונות שהפרו תנאים אלה.`,
    },
    {
      heading: "5. שימוש מותר",
      body: `מותר להשתמש בשירות לצרכים עסקיים ואישיים לגיטימיים. חל איסור על:
• שימוש העלול לפגוע, להעמיס יתר על המידה, או לפגוע בתשתית השירות.
• ניסיון לגשת לנתונים של משתמשים אחרים.
• שימוש אוטומטי (bots/scraping) ללא אישור מפורש בכתב.
• כל שימוש המפר חוק חל.`,
    },
    {
      heading: "6. קניין רוחני",
      body: `כל הזכויות בשירות, בקוד, בעיצוב ובלוגו שייכות למאור. הרישיון לשימוש הניתן לכם הוא אישי, מוגבל ולא ניתן להעברה.`,
    },
    {
      heading: "7. תוכן המשתמש",
      body: `המידע שאתם מכניסים לשירות (משימות, הערות, קבצים) שייך לכם. אתם מעניקים למאור רישיון מוגבל לעבד תוכן זה אך ורק לצורך מתן השירות.`,
    },
    {
      heading: "8. הגבלת אחריות",
      body: `השירות מסופק ללא אחריות מפורשת או משתמעת. מאור לא תישא באחריות לנזקים עקיפים, מקריים, או תוצאתיים הנובעים מהשימוש או מאי-היכולת להשתמש בשירות, לרבות אובדן נתונים.

המשמעות המעשית: אם השירות גרם להפסד עסקי, לאובדן מידע, או לנזק כלשהו — לא ניתן לתבוע את מאור על הנזק הכולל. האחריות המרבית שלנו מוגבלת לסכום ששולם לנו ב-12 החודשים האחרונים, או 100 דולר — הנמוך מבניהם.`,
    },
    {
      heading: "9. זמינות השירות",
      body: `איננו מתחייבים לזמינות רציפה ללא הפרעות. אנו שומרים את הזכות לשנות, להשהות, או להפסיק חלקים מהשירות בכל עת עם הודעה מוקדמת סבירה.`,
    },
    {
      heading: "10. ביטול חשבון",
      body: `ניתן לבטל את החשבון בכל עת. לאחר ביטול, הנתונים יימחקו תוך 30 יום. אנו שומרים את הזכות להפסיק שירות למשתמש שהפר תנאים אלה.`,
    },
    {
      heading: "11. דין וסמכות שיפוט",
      body: `הסכם זה כפוף לדיני מדינת ניו יורק, ארצות הברית. סמכות השיפוט הבלעדית הינה לבתי המשפט המוסמכים במחוז ניו יורק.`,
    },
    {
      heading: "12. שינויים בתנאים",
      body: `נודיע על שינויים מהותיים בדוא"ל לפחות 14 ימים מראש. המשך שימוש לאחר מועד כניסת השינויים לתוקף מהווה הסכמה.`,
    },
    {
      heading: "13. יצירת קשר",
      body: `לכל שאלה בנושא תנאים אלה: ${CONTACT_EMAIL}`,
    },
  ],
};

const enContent = {
  title: "Terms of Service",
  lastUpdated: `Last updated: ${EFFECTIVE_DATE}`,
  sections: [
    {
      heading: "1. Acceptance of Terms",
      body: `By using smrtesy you agree to these Terms. If you disagree, please discontinue use. The Service is intended for users 18 years of age or older.`,
    },
    {
      heading: "2. Description of Service",
      body: `smrtesy is a personal AI tool developed by Maor that helps with task management, email processing, scheduling, and generating insights. The Service is provided "AS IS".`,
    },
    {
      heading: "3. Restricted Access — Invitation Only",
      body: `The Service is not open to the general public. Access is permitted only to users who have received an explicit invitation from Maor, or who are members of an organization subscribed to the Service. Use without a valid invitation is prohibited and constitutes a violation of these Terms.`,
    },
    {
      heading: "4. Your Account",
      body: `• You are responsible for maintaining the security of your account credentials.
• You may not share your account with others.
• You must immediately report any unauthorized use of your account.
• We reserve the right to suspend accounts that violate these Terms.`,
    },
    {
      heading: "5. Acceptable Use",
      body: `You may use the Service for legitimate business and personal purposes. You may not:
• Use the Service in any way that could damage, overload, or impair the infrastructure.
• Attempt to access other users' data.
• Use automated means (bots/scraping) without express written permission.
• Use the Service in violation of any applicable law.`,
    },
    {
      heading: "6. Intellectual Property",
      body: `All rights in the Service, code, design, and logo belong to Maor. The license granted to you is personal, limited, and non-transferable.`,
    },
    {
      heading: "7. Your Content",
      body: `Information you enter into the Service (tasks, notes, files) belongs to you. You grant Maor a limited license to process such content solely to provide the Service.`,
    },
    {
      heading: "8. Limitation of Liability",
      body: `The Service is provided without express or implied warranty. Maor shall not be liable for indirect, incidental, or consequential damages arising from use or inability to use the Service, including data loss.

In plain terms: if the Service causes a business loss, data loss, or any other damage, Maor's liability is capped. Our total cumulative liability shall not exceed the amounts you paid us in the preceding 12 months, or $100 USD — whichever is lower.`,
    },
    {
      heading: "9. Service Availability",
      body: `We do not guarantee uninterrupted availability. We reserve the right to modify, suspend, or discontinue any part of the Service at any time with reasonable prior notice.`,
    },
    {
      heading: "10. Account Termination",
      body: `You may cancel your account at any time. Following cancellation, your data will be deleted within 30 days. We reserve the right to terminate service to users who violate these Terms.`,
    },
    {
      heading: "11. Governing Law",
      body: `This agreement is governed by the laws of the State of New York, United States. Exclusive jurisdiction is vested in the competent courts of New York County.`,
    },
    {
      heading: "12. Changes to Terms",
      body: `We will notify you of material changes via email at least 14 days in advance. Continued use after the effective date constitutes acceptance.`,
    },
    {
      heading: "13. Contact",
      body: `For questions about these Terms: ${CONTACT_EMAIL}`,
    },
  ],
};

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const content = locale === "en" ? enContent : heContent;
  const isRtl = locale !== "en";

  return (
    <div className="min-h-screen bg-muted" dir={isRtl ? "rtl" : "ltr"}>
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="mb-8">
          <Link
            href={`/${locale}/login`}
            className="text-sm text-primary hover:underline"
          >
            {locale === "en" ? "← Back to smrtesy" : "← חזרה ל-smrtesy"}
          </Link>
        </div>

        <div className="rounded-xl bg-background p-8 shadow-sm">
          <h1 className="mb-2 text-3xl font-bold text-foreground">
            {content.title}
          </h1>
          <p className="mb-8 text-sm text-muted-foreground">
            {content.lastUpdated}
          </p>

          <div className="space-y-6">
            {content.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="mb-2 text-lg font-semibold text-foreground">
                  {section.heading}
                </h2>
                <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {section.body}
                </p>
              </section>
            ))}
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} smrtesy · Maor
        </div>
      </div>
    </div>
  );
}
