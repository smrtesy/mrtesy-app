import { Sparkles, LayoutGrid, Shuffle } from "lucide-react";
import { AppGuideLayout } from "@/components/platform/AppGuideLayout";
import type { GuideFeature, GuideStep, GuideFAQ } from "@/components/platform/AppGuideLayout";

const features: GuideFeature[] = [
  {
    icon: Sparkles,
    title: "רעיונות שנראים ייחודיים",
    description: "מתארים נושא — ומקבלים כמה כיווני-עיצוב שונים באמת, לא 'המראה של AI'. השיטה בונה כל כיוון מ'עוגן' אחר של הנושא.",
  },
  {
    icon: LayoutGrid,
    title: "גלריה לבחירה בעין",
    description: "כל הכיוונים מוצגים זה לצד זה כתמונות. אתם מסתכלים ובוחרים — בלי צורך לדעת פונטים או צבעים.",
  },
  {
    icon: Shuffle,
    title: "קח מכל אחד",
    description: "אהבתם טיפוגרפיה מכיוון אחד וצבעים מאחר? בוחרים לכל ממד מאיפה לקחת, ומקבלים עיצוב-משולב מעודכן.",
  },
];

const steps: GuideStep[] = [
  {
    title: "מתארים נושא",
    description: "פרויקט חדש: מה מעצבים, לְמי, ובאילו שפות. שאר ההחלטות נגזרות מזה.",
  },
  {
    title: "מייצרים כיוונים",
    description: "לוחצים 'ייצר' — smrtDesign מריץ את שיטת-העיצוב דרך הקלוד המובנה ומחזיר כמה כיוונים מרונדרים.",
  },
  {
    title: "בוחרים או ממזגים",
    description: "בוחרים כיוון שלם, או ממזגים חלקים מכמה כיוונים לעיצוב-משולב אחד. הבחירה ננעלת כבריף של הפרויקט.",
  },
];

const faqs: GuideFAQ[] = [
  {
    question: "האם זה עולה כסף?",
    answer: "לא. הייצור רץ על הקלוד המובנה (המנוי) — אפס עלות API.",
  },
  {
    question: "למה זה לא נראה כמו כל אתר-AI?",
    answer: "כי כל כיוון נגזר מ'עוגן' ספציפי לנושא, עובר שער אנטי-קלישאה, ומשתנה גם בעימוד — לא רק בצבע. השיטה המלאה ב-docs/design-process.md.",
  },
  {
    question: "אפשר לערוך אחר כך?",
    answer: "הכיוון הנבחר נשמר כבריף. בהמשך אפשר לזקק אותו או לייצא — ואף לפתוח בכלי-עריכה חיצוני.",
  },
];

export default function SmrtDesignGuidePage() {
  return (
    <AppGuideLayout
      appName="smrtDesign"
      tagline="רעיונות עיצוב ייחודיים — לא 'המראה של AI'"
      description="מתארים נושא, מקבלים כמה כיווני-עיצוב שונים באמת, בוחרים בעין וממזגים את הטוב מכולם. רץ על הקלוד המובנה, בלי עלות API."
      features={features}
      steps={steps}
      faqs={faqs}
    />
  );
}
