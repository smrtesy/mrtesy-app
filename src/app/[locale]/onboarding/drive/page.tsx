"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";

export default function OnboardingStep2() {
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();

  function handleConnect() {
    window.location.href = "/api/auth/google?service=drive";
  }

  function handleSkip() {
    router.push(`/${locale}/onboarding/whatsapp`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <FolderOpen className="h-8 w-8 text-green-600" />
        </div>
        <CardTitle>{t("step2.title")}</CardTitle>
        <CardDescription>{t("step2.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <FolderOpen className="h-5 w-5 text-green-500" />
          <span className="flex-1">Google Drive</span>
          <span className="text-xs text-muted-foreground">drive.readonly</span>
        </div>
        <Button onClick={handleConnect} className="w-full min-h-[48px]">
          {t("connect")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>
        <div className="flex justify-center gap-2 pt-2">
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-blue-600" />
          <div className="h-2 w-8 rounded-full bg-gray-200" />
          <div className="h-2 w-8 rounded-full bg-gray-200" />
        </div>
      </CardContent>
    </Card>
  );
}
