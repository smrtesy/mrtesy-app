"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GuideFeature {
  icon: React.ElementType;
  title: string;
  description: string;
}

export interface GuideStep {
  title: string;
  description: string;
}

export interface GuideFAQ {
  question: string;
  answer: string;
}

interface Props {
  appName: string;
  tagline: string;
  description: string;
  features: GuideFeature[];
  steps: GuideStep[];
  faqs: GuideFAQ[];
}

function FAQItem({ question, answer }: GuideFAQ) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between py-4 text-start text-sm font-medium"
      >
        <span>{question}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <p className="pb-4 text-sm text-muted-foreground leading-relaxed">{answer}</p>
      )}
    </div>
  );
}

export function AppGuideLayout({ appName, tagline, description, features, steps, faqs }: Props) {
  return (
    <div className="max-w-2xl mx-auto space-y-10 py-8 px-4">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{appName}</h1>
        <p className="text-base text-muted-foreground font-medium">{tagline}</p>
        <p className="text-sm text-muted-foreground leading-relaxed pt-1">{description}</p>
      </div>

      {/* Features */}
      <section>
        <h2 className="text-base font-semibold mb-4">מה אפשר לעשות</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="rounded-lg border p-4 space-y-1.5">
              <div className="flex items-center gap-2">
                <f.icon className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-semibold">{f.title}</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="text-base font-semibold mb-4">איך זה עובד</h2>
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                {i + 1}
              </span>
              <div className="space-y-0.5 pt-0.5">
                <p className="text-sm font-semibold">{s.title}</p>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* FAQ */}
      {faqs.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-2">שאלות נפוצות</h2>
          <div className="divide-y rounded-lg border px-4">
            {faqs.map((faq) => (
              <FAQItem key={faq.question} {...faq} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
