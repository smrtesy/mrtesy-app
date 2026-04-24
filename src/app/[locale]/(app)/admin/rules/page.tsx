"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
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

const RULE_TYPES = ["skip", "skip_spam", "bot", "action", "style", "preference", "financial"];

const TYPE_LABELS: Record<string, string> = {
  skip:       "Skip",
  skip_spam:  "Skip Spam",
  bot:        "Bot",
  action:     "Action",
  style:      "Style",
  preference: "Preference",
  financial:  "Financial",
};

export default function AdminRulesPage() {
  const supabase = createClient();
  const [rules, setRules] = useState<Rule[]>([]);
  const [pendingSuggestions, setPendingSuggestions] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRule, setNewRule] = useState({
    trigger: "",
    rule_type: "skip",
    category: "",
    action: "",
    reason: "",
  });

  const loadRules = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("rules_memory")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    const all = data ?? [];
    setPendingSuggestions(all.filter((r) => r.suggestion_status === "pending"));
    setRules(all.filter((r) => r.suggestion_status !== "pending" || r.is_active));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  async function approveRule(id: string) {
    await supabase
      .from("rules_memory")
      .update({ suggestion_status: "approved", is_active: true })
      .eq("id", id);
    toast.success("Rule approved and activated");
    loadRules();
  }

  async function rejectRule(id: string) {
    await supabase
      .from("rules_memory")
      .update({ suggestion_status: "rejected", is_active: false })
      .eq("id", id);
    toast.success("Rule rejected");
    loadRules();
  }

  async function toggleRule(id: string, currentActive: boolean) {
    await supabase
      .from("rules_memory")
      .update({ is_active: !currentActive })
      .eq("id", id);
    loadRules();
  }

  async function deleteRule(id: string) {
    await supabase.from("rules_memory").delete().eq("id", id);
    toast.success("Rule deleted");
    loadRules();
  }

  async function addRule() {
    if (!newRule.trigger) { toast.error("Trigger is required"); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from("rules_memory").insert({
      user_id: user.id,
      trigger: newRule.trigger,
      rule_type: newRule.rule_type,
      category: newRule.category || null,
      action: newRule.action || null,
      reason: newRule.reason || null,
      is_active: true,
      created_by: "user",
      suggestion_status: "approved",
    });

    if (error) { toast.error(error.message); return; }
    toast.success("Rule added");
    setNewRule({ trigger: "", rule_type: "skip", category: "", action: "", reason: "" });
    setShowAddForm(false);
    loadRules();
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
      </div>
    );
  }

  const activeRules = rules.filter((r) => r.suggestion_status !== "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Filter Rules</h1>
        <Button size="sm" onClick={() => setShowAddForm((v) => !v)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Rule
        </Button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Rule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium mb-1 block">Trigger *</label>
                <Input
                  placeholder="e.g. sender = noreply@example.com"
                  value={newRule.trigger}
                  onChange={(e) => setNewRule((r) => ({ ...r, trigger: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Type</label>
                <Select
                  value={newRule.rule_type}
                  onValueChange={(v) => setNewRule((r) => ({ ...r, rule_type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Reason</label>
              <Textarea
                placeholder="Why this rule exists"
                rows={2}
                value={newRule.reason}
                onChange={(e) => setNewRule((r) => ({ ...r, reason: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={addRule}>Save Rule</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending AI suggestions */}
      {pendingSuggestions.length > 0 && (
        <Card className="border-yellow-200 bg-yellow-50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-yellow-600" />
              Pending AI Suggestions ({pendingSuggestions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingSuggestions.map((rule) => (
              <div key={rule.id} className="rounded-lg bg-white border p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="shrink-0">
                    {TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{rule.trigger}</p>
                    {rule.reason && (
                      <p className="text-xs text-muted-foreground mt-0.5">{rule.reason}</p>
                    )}
                    {rule.suggestion_confidence != null && (
                      <p className="text-xs text-muted-foreground">
                        Confidence: {Math.round(rule.suggestion_confidence * 100)}%
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 text-red-500 h-8"
                    onClick={() => rejectRule(rule.id)}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1 h-8"
                    onClick={() => approveRule(rule.id)}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active rules */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Rules ({activeRules.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {activeRules.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No rules yet. Add one or run the classifier to generate AI suggestions.
            </p>
          ) : (
            <div className="space-y-2">
              {activeRules.map((rule) => (
                <div
                  key={rule.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${!rule.is_active ? "opacity-50" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">
                        {TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                      </Badge>
                      {rule.created_by === "claude" && (
                        <Badge variant="outline" className="text-xs bg-blue-50 text-blue-600">
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
                      title={rule.is_active ? "Disable" : "Enable"}
                    >
                      {rule.is_active ? (
                        <ToggleRight className="h-4 w-4 text-green-500" />
                      ) : (
                        <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-400 hover:text-red-600"
                      onClick={() => deleteRule(rule.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
