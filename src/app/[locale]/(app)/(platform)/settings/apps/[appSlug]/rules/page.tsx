"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2, XCircle, Plus, Lightbulb, Trash2, ToggleLeft, ToggleRight,
} from "lucide-react";
import { toast } from "sonner";

interface Rule {
  id: string;
  trigger: string;
  rule_type: string;
  category: string | null;
  action: string | null;
  reason: string | null;
  is_active: boolean;
  created_by: string;
  suggestion_status: string | null;
  suggestion_confidence: number | null;
  created_at: string;
}

interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

const RULE_TYPES = ["skip", "skip_spam", "bot", "action", "style", "preference", "financial"];

const GMAIL_CATEGORIES = [
  { key: "promotions", labelKey: "categoryPromotions", descKey: "categoryPromotionsDesc" },
  { key: "social",     labelKey: "categorySocial",     descKey: "categorySocialDesc" },
  { key: "forums",     labelKey: "categoryForums",     descKey: "categoryForumsDesc" },
  { key: "updates",    labelKey: "categoryUpdates",    descKey: "categoryUpdatesDesc" },
] as const;

export default function SettingsRulesPage() {
  const t = useTranslations("settingsRules");
  const supabase = createClient();
  const { appSlug } = useParams<{ appSlug: string }>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [pendingSuggestions, setPendingSuggestions] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(true);
  const [newRule, setNewRule] = useState({
    trigger: "",
    rule_type: "skip",
    category: "",
    action: "",
    reason: "",
  });

  const typeLabel = useCallback(
    (rt: string) => {
      const key = `type${rt.charAt(0).toUpperCase() + rt.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase())}`;
      try {
        return t(key as Parameters<typeof t>[0]);
      } catch {
        return rt;
      }
    },
    [t],
  );

  const loadRules = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("rules_memory")
      .select("*")
      .eq("user_id", user.id)
      .eq("app_slug", appSlug)
      .order("created_at", { ascending: false });

    const all: Rule[] = data ?? [];
    setPendingSuggestions(all.filter((r) => r.suggestion_status === "pending"));
    setRules(all.filter((r) => r.suggestion_status !== "pending" || r.is_active));
    setLoading(false);
  }, [supabase, appSlug]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  useEffect(() => {
    api<{ calendars: CalendarInfo[] }>("/api/sync/calendars")
      .then((res) => setCalendars(res.calendars))
      .catch(() => setCalendars([]))
      .finally(() => setCalendarsLoading(false));
  }, []);

  async function approveRule(id: string) {
    const prev = pendingSuggestions;
    const target = prev.find((r) => r.id === id);
    setPendingSuggestions((ps) => ps.filter((r) => r.id !== id));
    if (target) setRules((rs) => [{ ...target, suggestion_status: "approved", is_active: true }, ...rs]);
    const { error } = await supabase
      .from("rules_memory")
      .update({ suggestion_status: "approved", is_active: true })
      .eq("id", id);
    if (error) {
      setPendingSuggestions(prev);
      setRules((rs) => rs.filter((r) => r.id !== id));
      toast.error(error.message);
      return;
    }
    toast.success(t("ruleApproved"));
  }

  async function rejectRule(id: string) {
    const prev = pendingSuggestions;
    setPendingSuggestions((ps) => ps.filter((r) => r.id !== id));
    const { error } = await supabase
      .from("rules_memory")
      .update({ suggestion_status: "rejected", is_active: false })
      .eq("id", id);
    if (error) {
      setPendingSuggestions(prev);
      toast.error(error.message);
      return;
    }
    toast.success(t("ruleRejected"));
  }

  // Optimistic updates keep the DOM stable on every click. We previously
  // reloaded the entire rules list on each toggle, which forced React to
  // remount cards in a new order — the user saw items "jump" as sections
  // shrank/grew between the click and the re-fetch landing.

  async function toggleRule(id: string, currentActive: boolean) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, is_active: !currentActive } : r)));
    const { error } = await supabase
      .from("rules_memory")
      .update({ is_active: !currentActive })
      .eq("id", id);
    if (error) {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, is_active: currentActive } : r)));
      toast.error(error.message);
    }
  }

  async function deleteRule(id: string) {
    const prev = rules;
    setRules((rs) => rs.filter((r) => r.id !== id));
    const { error } = await supabase.from("rules_memory").delete().eq("id", id);
    if (error) {
      setRules(prev);
      toast.error(error.message);
      return;
    }
    toast.success(t("ruleDeleted"));
  }

  async function addRule() {
    if (!newRule.trigger) { toast.error(t("triggerRequired")); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from("rules_memory")
      .insert({
        user_id: user.id,
        app_slug: appSlug,
        trigger: newRule.trigger,
        rule_type: newRule.rule_type,
        category: newRule.category || null,
        action: newRule.action || null,
        reason: newRule.reason || null,
        is_active: true,
        created_by: "user",
        suggestion_status: "approved",
      })
      .select()
      .single();

    if (error) { toast.error(error.message); return; }
    if (data) setRules((rs) => [data as Rule, ...rs]);
    toast.success(t("ruleAdded"));
    setNewRule({ trigger: "", rule_type: "skip", category: "", action: "", reason: "" });
    setShowAddForm(false);
  }

  async function toggleGmailCategory(catKey: string, currentRule: Rule | undefined) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (currentRule) {
      setRules((prev) =>
        prev.map((r) => (r.id === currentRule.id ? { ...r, is_active: !currentRule.is_active } : r)),
      );
      const { error } = await supabase
        .from("rules_memory")
        .update({ is_active: !currentRule.is_active })
        .eq("id", currentRule.id);
      if (error) {
        setRules((prev) =>
          prev.map((r) => (r.id === currentRule.id ? { ...r, is_active: currentRule.is_active } : r)),
        );
        toast.error(error.message);
      }
      return;
    }

    const { data, error } = await supabase
      .from("rules_memory")
      .insert({
        user_id: user.id,
        app_slug: appSlug,
        rule_type: "skip",
        trigger: `category=${catKey}`,
        is_active: true,
        created_by: "system",
        suggestion_status: "approved",
      })
      .select()
      .single();
    if (error) { toast.error(error.message); return; }
    if (data) setRules((rs) => [data as Rule, ...rs]);
  }

  async function toggleCalendar(calId: string, currentRule: Rule | undefined) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (currentRule) {
      const prev = rules;
      setRules((rs) => rs.filter((r) => r.id !== currentRule.id));
      const { error } = await supabase.from("rules_memory").delete().eq("id", currentRule.id);
      if (error) {
        setRules(prev);
        toast.error(error.message);
      }
      return;
    }

    const { data, error } = await supabase
      .from("rules_memory")
      .insert({
        user_id: user.id,
        app_slug: appSlug,
        rule_type: "skip",
        trigger: `calendar=${calId}`,
        is_active: true,
        created_by: "system",
        suggestion_status: "approved",
      })
      .select()
      .single();
    if (error) { toast.error(error.message); return; }
    if (data) setRules((rs) => [data as Rule, ...rs]);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
      </div>
    );
  }

  const activeRules = rules.filter((r) => r.suggestion_status !== "pending");
  const categoryRules = activeRules.filter((r) => r.trigger.match(/^category=/i));
  const calendarRules = activeRules.filter((r) => r.trigger.match(/^calendar=/i));
  // Unified address rules — match from=, to=, domain= triggers under one heading
  // so the user doesn't see "Skip Addresses" and "Other Rules" with what looks
  // like the same thing in both.
  const skipAddressRules = activeRules.filter(
    (r) =>
      (r.rule_type === "skip" || r.rule_type === "skip_spam") &&
      /^(from|to|domain)=/i.test(r.trigger),
  );
  // Content-phrase skip rules (trigger `contains=<phrase>`) — shown under their
  // own heading and the phrase rendered without the `contains=` prefix.
  const contentSkipRules = activeRules.filter(
    (r) => r.rule_type === "skip" && /^contains=/i.test(r.trigger),
  );
  const botRules = activeRules.filter((r) => r.rule_type === "bot");
  const otherRules = activeRules.filter(
    (r) =>
      !categoryRules.includes(r) &&
      !calendarRules.includes(r) &&
      !skipAddressRules.includes(r) &&
      !contentSkipRules.includes(r) &&
      !botRules.includes(r) &&
      !["style", "preference", "financial"].includes(r.rule_type),
  );

  function getCategoryRule(catKey: string): Rule | undefined {
    return categoryRules.find((r) => r.trigger.toLowerCase() === `category=${catKey}`);
  }

  function getCalendarSkipRule(calId: string): Rule | undefined {
    return calendarRules.find((r) => r.trigger === `calendar=${calId}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold min-w-0 truncate">{t("title")}</h1>
        <Button size="sm" onClick={() => setShowAddForm((v) => !v)} className="shrink-0 gap-1.5">
          <Plus className="h-4 w-4" />
          {t("addRule")}
        </Button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <Card>
          <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
            <CardTitle className="text-base">{t("newRule")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 md:px-6 md:pb-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium mb-1 block">{t("triggerLabel")}</label>
                <Input
                  placeholder={t("triggerPlaceholder")}
                  value={newRule.trigger}
                  onChange={(e) => setNewRule((r) => ({ ...r, trigger: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">{t("typeLabel")}</label>
                <Select
                  value={newRule.rule_type}
                  onValueChange={(v) => setNewRule((r) => ({ ...r, rule_type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TYPES.map((rt) => (
                      <SelectItem key={rt} value={rt}>{typeLabel(rt)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">{t("reasonLabel")}</label>
              <Textarea
                placeholder={t("reasonPlaceholder")}
                rows={2}
                value={newRule.reason}
                onChange={(e) => setNewRule((r) => ({ ...r, reason: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                {t("cancel")}
              </Button>
              <Button size="sm" onClick={addRule}>{t("saveRule")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gmail Filters */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base">{t("gmailFilters")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4 md:px-6 md:pb-6">
          {GMAIL_CATEGORIES.map((cat) => {
            const rule = getCategoryRule(cat.key);
            const isActive = rule ? rule.is_active : false;
            return (
              <div key={cat.key} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{t(cat.labelKey)}</p>
                  <p className="text-xs text-muted-foreground">{t(cat.descKey)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => toggleGmailCategory(cat.key, rule)}
                  title={isActive ? t("disable") : t("enable")}
                >
                  {isActive ? (
                    <ToggleRight className="h-5 w-5 text-status-ok" />
                  ) : (
                    <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                  )}
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Calendar Filters */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base">{t("calendarFilters")}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
          {calendarsLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />)}
            </div>
          ) : calendars.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">{t("calendarsLoadError")}</p>
          ) : (
            <div className="space-y-2">
              {calendars.map((cal) => {
                const skipRule = getCalendarSkipRule(cal.id);
                const isIncluded = !skipRule;
                return (
                  <div key={cal.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cal.summary}</p>
                      {cal.primary && (
                        <p className="text-xs text-muted-foreground">{t("primaryCalendar")}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => toggleCalendar(cal.id, skipRule)}
                      title={isIncluded ? t("excludeCalendar") : t("includeCalendar")}
                    >
                      {isIncluded ? (
                        <ToggleRight className="h-5 w-5 text-status-ok" />
                      ) : (
                        <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Skip Addresses — unified from=, to=, domain= */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base">{t("skipAddresses", { count: skipAddressRules.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4 md:px-6 md:pb-6">
          {skipAddressRules.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">{t("skipAddressesEmpty")}</p>
          ) : (
            skipAddressRules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-start gap-3 rounded-lg border p-3 ${!rule.is_active ? "opacity-50" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono truncate">{rule.trigger}</span>
                  {rule.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5">{rule.reason}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleRule(rule.id, rule.is_active)}
                    title={rule.is_active ? t("disable") : t("enable")}
                  >
                    {rule.is_active ? (
                      <ToggleRight className="h-4 w-4 text-status-ok" />
                    ) : (
                      <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                    onClick={() => deleteRule(rule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Content phrases to skip — contains= rules */}
      <Card>
        <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
          <CardTitle className="text-base">{t("contentSkip", { count: contentSkipRules.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4 md:px-6 md:pb-6">
          {contentSkipRules.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">{t("contentSkipEmpty")}</p>
          ) : (
            contentSkipRules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-start gap-3 rounded-lg border p-3 ${!rule.is_active ? "opacity-50" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono truncate">&quot;{rule.trigger.replace(/^contains=/i, "")}&quot;</span>
                  {rule.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5">{rule.reason}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleRule(rule.id, rule.is_active)}
                    title={rule.is_active ? t("disable") : t("enable")}
                  >
                    {rule.is_active ? (
                      <ToggleRight className="h-4 w-4 text-status-ok" />
                    ) : (
                      <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                    onClick={() => deleteRule(rule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Bot Phones */}
      {botRules.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
            <CardTitle className="text-base">{t("botPhones", { count: botRules.length })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4 md:px-6 md:pb-6">
            {botRules.map((rule) => (
              <div key={rule.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono truncate">{rule.trigger}</span>
                  {rule.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5">{rule.reason}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:bg-destructive/10 shrink-0"
                  onClick={() => deleteRule(rule.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Other Rules — non-skip, non-bot, non-style/preference/financial */}
      {otherRules.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
            <CardTitle className="text-base">{t("otherRules", { count: otherRules.length })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4 md:px-6 md:pb-6">
            {otherRules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-start gap-3 rounded-lg border p-3 ${!rule.is_active ? "opacity-50" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-xs">
                      {typeLabel(rule.rule_type)}
                    </Badge>
                    {rule.created_by === "claude" && (
                      <Badge variant="outline" className="text-xs bg-accent text-accent-foreground">
                        AI
                      </Badge>
                    )}
                    <span className="text-sm font-medium truncate">{rule.trigger}</span>
                  </div>
                  {rule.reason && (
                    <p className="text-xs text-muted-foreground mt-1">{rule.reason}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleRule(rule.id, rule.is_active)}
                    title={rule.is_active ? t("disable") : t("enable")}
                  >
                    {rule.is_active ? (
                      <ToggleRight className="h-4 w-4 text-status-ok" />
                    ) : (
                      <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                    onClick={() => deleteRule(rule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Pending AI suggestions */}
      {pendingSuggestions.length > 0 && (
        <Card className="border-status-warn bg-status-warn-bg">
          <CardHeader className="p-4 pb-2 md:p-6 md:pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-status-warn" />
              {t("pendingSuggestions", { count: pendingSuggestions.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 md:px-6 md:pb-6">
            {pendingSuggestions.map((rule) => (
              <div key={rule.id} className="rounded-lg bg-card border p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="shrink-0">
                    {typeLabel(rule.rule_type)}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{rule.trigger}</p>
                    {rule.reason && (
                      <p className="text-xs text-muted-foreground mt-0.5">{rule.reason}</p>
                    )}
                    {rule.suggestion_confidence != null && (
                      <p className="text-xs text-muted-foreground">
                        {t("confidence", { percent: Math.round(rule.suggestion_confidence * 100) })}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 text-destructive h-8"
                    onClick={() => rejectRule(rule.id)}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    {t("reject")}
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1 h-8"
                    onClick={() => approveRule(rule.id)}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t("approve")}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
