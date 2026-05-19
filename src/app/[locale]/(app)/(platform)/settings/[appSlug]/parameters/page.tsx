"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, Save, X } from "lucide-react";

// Per-user parameters the user owns. System-wide knobs (models, batch size,
// truncation, calendar window) live in `smrttask_system_params` and are
// edited only by super-admins. The per-user daily AI budget also stays on
// user_settings but is only surfaced under /admin/users/[id] — the user
// themselves doesn't see it.
interface UserParams {
  my_emails: string[];
  office_addresses: string[];
  skip_senders: string[];
  skip_recipients: string[];
}

const EMPTY: UserParams = {
  my_emails: [],
  office_addresses: [],
  skip_senders: [],
  skip_recipients: [],
};

export default function SettingsParametersPage() {
  const t = useTranslations("settingsParameters");
  const supabase = createClient();
  const [params, setParams] = useState<UserParams>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("user_settings")
      .select("my_emails, office_addresses, skip_senders, skip_recipients")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) {
      setParams({
        my_emails: data.my_emails ?? [],
        office_addresses: data.office_addresses ?? [],
        skip_senders: data.skip_senders ?? [],
        skip_recipients: data.skip_recipients ?? [],
      });
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: user.id, ...params }, { onConflict: "user_id" });

    if (error) toast.error(error.message);
    else toast.success(t("saved"));
    setSaving(false);
  }

  function setChips(key: keyof UserParams, v: string[]) {
    setParams((p) => ({ ...p, [key]: v }));
  }

  if (loading) {
    return (
      <div className="container max-w-2xl py-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("sendersSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t("myEmailsLabel")} hint={t("myEmailsHint")}>
            <ChipInput
              values={params.my_emails}
              onChange={(v) => setChips("my_emails", v)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label={t("officeAddressesLabel")} hint={t("officeAddressesHint")}>
            <ChipInput
              values={params.office_addresses}
              onChange={(v) => setChips("office_addresses", v)}
              placeholder="orders@company.com"
            />
          </Field>
          <Field label={t("skipSendersLabel")} hint={t("skipSendersHint")}>
            <ChipInput
              values={params.skip_senders}
              onChange={(v) => setChips("skip_senders", v)}
              placeholder="notifications@vercel.com"
            />
          </Field>
          <Field label={t("skipRecipientsLabel")} hint={t("skipRecipientsHint")}>
            <ChipInput
              values={params.skip_recipients}
              onChange={(v) => setChips("skip_recipients", v)}
              placeholder="list@example.com"
            />
          </Field>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving} className="gap-2">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {t("save")}
      </Button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" dir="auto">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground" dir="auto">{hint}</p>}
    </div>
  );
}

// Inline chip-input: type a value, press Enter or comma to add. Click X on a
// chip to remove. Backspace on empty input pops the last chip.
function ChipInput({
  values, onChange, placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) { setDraft(""); return; }
    onChange([...values, v]);
    setDraft("");
  }

  function remove(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
            dir="auto"
          >
            {v}
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="remove"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            remove(values.length - 1);
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        className="max-w-md"
      />
    </div>
  );
}
