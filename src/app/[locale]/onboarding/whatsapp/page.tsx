"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MessageCircle, Copy, Check } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
// The webhook URL is platform-fixed; we only expose it here so the user
// can paste it straight into DualHook's "Webhook Override" field.
const WEBHOOK_URL = `${BACKEND_URL}/api/webhooks/whatsapp`;

export default function OnboardingWhatsApp() {
  const t = useTranslations("onboarding");
  const tWa = useTranslations("onboardingWhatsapp");
  const { locale } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect");
  const supabase = createClient();
  const isHe = locale === "he";

  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [displayPhone, setDisplayPhone] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  function copyToClipboard(key: string, value: string) {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      },
      () => toast.error("Clipboard error"),
    );
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await fetch(`${BACKEND_URL}/api/me/whatsapp/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim() || undefined,
          business_id: businessId.trim() || undefined,
          display_phone_number: displayPhone.trim() || undefined,
          access_token: accessToken.trim() || undefined,
          app_secret: appSecret.trim() || undefined,
          verify_token: verifyToken.trim() || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);

      toast.success(tWa("whatsappConnected"));
      router.push(redirectTo === "settings" ? `/${locale}/settings` : `/${locale}/onboarding/setup`);
    } catch (e) {
      toast.error(tWa("connectError", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setConnecting(false);
    }
  }

  function handleSkip() {
    router.push(redirectTo === "settings" ? `/${locale}/settings` : `/${locale}/onboarding/setup`);
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-status-ok-bg">
          <MessageCircle className="h-8 w-8 text-status-ok" />
        </div>
        <CardTitle>{tWa("title")}</CardTitle>
        <CardDescription>{tWa("description")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* How it works */}
        <div className="rounded-lg border bg-muted/50 p-3 text-xs space-y-1.5" dir={isHe ? "rtl" : "ltr"}>
          <p className="font-medium">{tWa("howItWorks")}</p>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
            <li>{tWa("step1")}</li>
            <li>{tWa("step2")}</li>
            <li>{tWa("step3")}</li>
          </ol>
        </div>

        {/* DualHook setup */}
        <div className="rounded-lg border bg-status-warn-bg border-status-warn/30 p-3 text-xs space-y-2" dir={isHe ? "rtl" : "ltr"}>
          <p className="font-medium text-status-warn">{tWa("dualhookSetup")}</p>
          <ol className="list-decimal list-inside space-y-1 text-status-warn">
            <li>{tWa("dualhookStep1")}</li>
            <li>{tWa("dualhookStep2")}</li>
            <li>{tWa("dualhookStep3")}</li>
          </ol>
        </div>

        {/* Webhook URL — copyable */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("webhookUrlLabel")}</label>
          <div className="flex gap-2">
            <Input value={WEBHOOK_URL} readOnly dir="ltr" className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => copyToClipboard("url", WEBHOOK_URL)}
              aria-label={tWa("copyToClipboard")}
            >
              {copiedKey === "url" ? <Check className="h-4 w-4 text-status-ok" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Phone Number ID */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("phoneNumberIdLabel")}</label>
          <Input
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="1037675792763815"
          />
          <p className="text-xs text-muted-foreground">{tWa("phoneNumberIdHint")}</p>
        </div>

        {/* WABA ID */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("wabaIdLabel")}</label>
          <Input
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="905538528840620"
          />
          <p className="text-xs text-muted-foreground">{tWa("wabaIdHint")}</p>
        </div>

        {/* Business ID — kept for completeness; not used by the message/media flow today. */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("businessIdLabel")}</label>
          <Input
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="2156077741835869"
          />
          <p className="text-xs text-muted-foreground">{tWa("businessIdHint")}</p>
        </div>

        {/* Display phone (optional) */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("displayPhoneLabel")}</label>
          <Input
            value={displayPhone}
            onChange={(e) => setDisplayPhone(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="+19293330248"
          />
        </div>

        {/* Access Token — Meta Cloud API Bearer used for media fetch. */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("accessTokenLabel")}</label>
          <Input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="EAAxxxxxxxxx..."
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{tWa("accessTokenHint")}</p>
        </div>

        {/* App Secret — Meta signs webhooks with this. */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("appSecretLabel")}</label>
          <Input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="••••••••••••••••••••••••"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{tWa("appSecretHint")}</p>
        </div>

        {/* Verify Token — user-chosen, also pasted into DualHook. */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{tWa("verifyTokenLabel")}</label>
          <Input
            type="password"
            value={verifyToken}
            onChange={(e) => setVerifyToken(e.target.value)}
            dir="ltr"
            className="font-mono text-xs"
            placeholder="a-random-string-you-choose"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{tWa("verifyTokenHint")}</p>
        </div>

        <Button onClick={handleConnect} disabled={connecting || !phoneNumberId} className="w-full min-h-[48px]">
          {tWa("confirmConnection")}
        </Button>
        <Button onClick={handleSkip} variant="ghost" className="w-full min-h-[48px]">
          {t("skip")}
        </Button>

        {/* Progress dots */}
        <div className="flex justify-center gap-2 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-2 w-8 rounded-full ${i < 3 ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
