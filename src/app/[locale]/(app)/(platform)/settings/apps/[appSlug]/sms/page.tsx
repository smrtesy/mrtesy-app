"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Smartphone } from "lucide-react";
import { SmsDeviceManager } from "@/components/smrttask/sms/SmsDeviceManager";

export default function SmsDevicesPage() {
  const t = useTranslations("sms");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <SmsDeviceManager />
      </CardContent>
    </Card>
  );
}
