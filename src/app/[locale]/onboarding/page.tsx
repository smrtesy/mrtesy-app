"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Calendar } from "lucide-react";

export default function OnboardingStep1() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();

  function handleConnect() {
    window.location.href = "/api/auth/google?service=gmail_calendar";
  }

  function handleSkip() {
    router.push(`/${locale}/onboarding/drive`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
          <Mail className="h-8 w-8 text-blue-600" />
        </div>
        <CardTitle>{t("step1.title")}</CardTitle>
        <CardDescription>{t("step1.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Mail className="h-5 w-5 text-red-500" />
          <span className="flex-1">Gmail</span>
          <span className="text-xs text-muted-foreground">gmail.modify</span>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Calendar className="h-5 w-5 text-blue-500" />
          <span className="flex-1">Google Calendar</span>
          <span className="text-xs text-muted-foreground">calendar</span>
        </div>
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {t("connect")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>
        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-gray-200" />
          <div className="h-2 w-8 rounded-full bg-gray-200" />
          <div className="h-2 w-8 rounded-full bg-gray-200" />
        </div>
      </CardContent>
    </Card>
  );
}
