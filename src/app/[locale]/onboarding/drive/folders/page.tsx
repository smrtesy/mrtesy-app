"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen, ArrowRight } from "lucide-react";
import { DriveFolderManager } from "@/components/smrttask/drive/DriveFolderManager";

export default function OnboardingDriveFolders() {
  const t = useTranslations("onboarding.driveFoldersStep");
  const tBase = useTranslations("onboarding");
  const { locale } = useParams() as { locale: string };
  const router = useRouter();
  const [selectedCount, setSelectedCount] = useState<number>(0);

  function goNext() {
    router.push(`/${locale}/onboarding/whatsapp`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <FolderOpen className="h-8 w-8 text-green-600" />
        </div>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DriveFolderManager onChange={setSelectedCount} />

        <Button
          onClick={goNext}
          className="w-full min-h-[48px] gap-2"
          variant={selectedCount > 0 ? "default" : "outline"}
        >
          {selectedCount > 0 ? t("continue") : tBase("skip")}
          <ArrowRight className="h-4 w-4 rtl:rotate-180" />
        </Button>

        {/* Step indicator: this is still "Drive" (sub-step), so we
            mirror the dots from the parent Drive page (2 of 4). */}
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
