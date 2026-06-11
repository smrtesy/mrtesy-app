import Link from "next/link";

const EFFECTIVE_DATE = "June 11, 2025";
const COMPANY_NAME = "smrtesy";
const CONTACT_EMAIL = "support@smrtesy.com";

const heContent = {
  title: "מדיניות פרטיות",
  lastUpdated: `עודכן לאחרונה: 11 ביוני 2025`,
  sections: [
    {
      heading: "1. מי אנחנו",
      body: `smrtesy ("אנחנו", "השירות") הינו כלי AI אישי המופעל על ידי Maor.org. השירות זמין בכתובת app.smrtesy.com.`,
    },
    {
      heading: "2. המידע שאנו אוספים",
      body: `אנו אוספים את המידע הבא:
• פרטי חשבון: שם, כתובת דוא"ל, ותמונת פרופיל מגוגל כאשר אתם מתחברים עם Google OAuth.
• נתוני שימוש: פעולות שבוצעו בשירות, העדפות, ומשימות שנוצרו.
• נתוני Google: גישה לתיבת דואר נכנס, יומן ו-Drive בהתאם להרשאות שנתתם — לצורך יצירת משימות, סיכומים ועיבוד אוטומטי בלבד.
• נתונים טכניים: כתובת IP, סוג דפדפן, ונתוני שימוש אנונימיים לצורכי אבחון.`,
    },
    {
      heading: "3. כיצד אנו משתמשים במידע",
      body: `המידע משמש אך ורק לצורך:
• הפעלת השירות והצגת הממשק האישי שלכם.
• עיבוד מיילים, אירועי יומן וקבצים כדי לייצר משימות ותובנות.
• שיפור השירות ואבחון תקלות.
• שליחת הודעות מערכת חיוניות (אין שיווק ללא הסכמה מפורשת).`,
    },
    {
      heading: "4. שיתוף מידע עם צדדים שלישיים",
      body: `איננו מוכרים את המידע שלכם. אנו משתפים מידע רק עם:
• Supabase Inc. — ספק אחסון מסד הנתונים (מאובטח ומוצפן).
• Anthropic, Inc. — ספק ה-AI המעבד בקשות טקסטואליות (ללא שמירת נתונים אישיים לאחר העיבוד).
• Google LLC — לצורך OAuth ולגישה לנתונים שהרשיתם.
אין שיתוף נתונים לצרכי פרסום.`,
    },
    {
      heading: "5. אחסון ואבטחה",
      body: `הנתונים מאוחסנים בשרתים של Supabase הממוקמים באיחוד האירופי. אנו מיישמים הצפנה בשידור (TLS) ובאחסון. אנו שומרים נתונים כל עוד החשבון פעיל, ומוחקים אותם תוך 30 יום ממועד הסגירה לפי בקשה.`,
    },
    {
      heading: "6. זכויותיכם",
      body: `בהתאם לחוק הגנת הפרטיות הישראלי ו-GDPR (ככל שרלוונטי) יש לכם זכות:
• לגשת לנתוניכם האישיים.
• לתקן נתונים שגויים.
• למחוק את חשבונכם וכל הנתונים הקשורים אליו.
• לייצא את הנתונים שלכם.
לפניות: ${CONTACT_EMAIL}`,
    },
    {
      heading: "7. עוגיות (Cookies)",
      body: `אנו משתמשים בעוגיות חיוניות בלבד לניהול הסשן. איננו משתמשים בעוגיות מעקב או פרסומיות.`,
    },
    {
      heading: "8. שינויים במדיניות",
      body: `נודיע על שינויים מהותיים בדוא"ל או בהודעה בממשק לפחות 14 ימים מראש. המשך השימוש לאחר הודעה מהווה הסכמה.`,
    },
    {
      heading: "9. יצירת קשר",
      body: `לשאלות בנושא פרטיות: ${CONTACT_EMAIL}`,
    },
  ],
};

const enContent = {
  title: "Privacy Policy",
  lastUpdated: `Last updated: ${EFFECTIVE_DATE}`,
  sections: [
    {
      heading: "1. Who We Are",
      body: `smrtesy ("we", "the Service") is a personal AI tool operated by Maor.org, available at app.smrtesy.com.`,
    },
    {
      heading: "2. Information We Collect",
      body: `We collect the following information:
• Account details: name, email address, and profile picture from Google when you sign in via Google OAuth.
• Usage data: actions taken in the Service, preferences, and tasks created.
• Google data: access to your inbox, calendar, and Drive as authorized by you — solely for creating tasks, summaries, and automated processing.
• Technical data: IP address, browser type, and anonymous usage data for diagnostics.`,
    },
    {
      heading: "3. How We Use Your Information",
      body: `Your information is used solely to:
• Operate the Service and display your personal workspace.
• Process emails, calendar events, and files to generate tasks and insights.
• Improve the Service and diagnose issues.
• Send essential system notifications (no marketing without explicit consent).`,
    },
    {
      heading: "4. Sharing With Third Parties",
      body: `We do not sell your data. We share information only with:
• Supabase Inc. — our database storage provider (secured and encrypted).
• Anthropic, Inc. — AI provider that processes text requests (no personal data retained after processing).
• Google LLC — for OAuth and access to data you have authorized.
No data sharing for advertising purposes.`,
    },
    {
      heading: "5. Storage and Security",
      body: `Data is stored on Supabase servers located in the European Union. We implement encryption in transit (TLS) and at rest. We retain data for as long as your account is active and delete it within 30 days of account closure upon request.`,
    },
    {
      heading: "6. Your Rights",
      body: `Under Israeli Privacy Protection Law and GDPR (where applicable) you have the right to:
• Access your personal data.
• Correct inaccurate data.
• Delete your account and all associated data.
• Export your data.
Contact us: ${CONTACT_EMAIL}`,
    },
    {
      heading: "7. Cookies",
      body: `We use only essential cookies for session management. We do not use tracking or advertising cookies.`,
    },
    {
      heading: "8. Policy Changes",
      body: `We will notify you of material changes via email or in-app notice at least 14 days in advance. Continued use after notice constitutes acceptance.`,
    },
    {
      heading: "9. Contact",
      body: `Privacy questions: ${CONTACT_EMAIL}`,
    },
  ],
};

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const content = locale === "en" ? enContent : heContent;
  const isRtl = locale !== "en";

  return (
    <div
      className="min-h-screen bg-muted"
      dir={isRtl ? "rtl" : "ltr"}
    >
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
          © {new Date().getFullYear()} {COMPANY_NAME} · Maor.org
        </div>
      </div>
    </div>
  );
}
