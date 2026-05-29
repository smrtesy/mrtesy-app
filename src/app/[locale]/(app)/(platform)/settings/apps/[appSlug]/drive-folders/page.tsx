"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";
import { DriveFolderManager } from "@/components/smrttask/drive/DriveFolderManager";

export default function DriveFoldersPage() {
  const t = useTranslations("driveFolders");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="h-5 w-5" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <DriveFolderManager />
      </CardContent>
    </Card>
  );
}
