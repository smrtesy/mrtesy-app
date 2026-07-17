"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import {
  Search, Plus, Loader2, Trash2, ExternalLink, X, Pencil, Check,
  ShieldCheck, KeyRound, Settings2, Sparkles, MessageCircle, MessageSquare,
} from "lucide-react";

import { useScreenRouter } from "@/lib/panes/nav";
import { useOpenWhatsAppChat } from "@/hooks/useOpenWhatsAppChat";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

type Scope = "personal" | "org" | "unclassified";

interface Fact {
  id: string;
  scope: Scope;
  entity: string;
  attribute: string;
  value: string;
  effective_date: string | null;
  confidence: number | null;
  verified: boolean;
  source_type: string | null;
  source_url: string | null;
  updated_at: string;
}

interface AskFact extends Fact {
  similarity?: number;
}
interface VaultMatch { id: string; label: string; username: string | null; url: string | null; }
interface AnswerState { answer: string | null; facts: AskFact[]; vaultMatches: VaultMatch[]; }

interface SecretSuggestion {
  id: string;
  label: string;
  username: string | null;
  url: string | null;
  source_url: string | null;
  status: string;
}

const emptyForm = { entity: "", attribute: "", value: "", scope: "unclassified" as Scope, effective_date: "", source_url: "" };
const TABS: (Scope | "all")[] = ["all", "personal", "org", "unclassified"];

/**
 * Source link for a fact. WhatsApp/SMS sources open the IN-APP reader (docked
 * panel or the /whatsapp,/sms screens) instead of an external wa.me / sms:
 * link — the user wants the conversation inside the platform, not a new chat in
 * the native client. Everything else (Gmail/Drive/Calendar) keeps its verbatim
 * external deep link. Mirrors the routing in common/SourceLink.tsx.
 */
function InfoSourceLink({ sourceType, sourceUrl }: { sourceType: string | null; sourceUrl: string }) {
  const t = useTranslations("smrtInfo");
  const openWhatsApp = useOpenWhatsAppChat();
  const router = useScreenRouter();
  const { locale } = useParams() as { locale: string };
  const cls = "text-primary text-xs inline-flex items-center gap-0.5";

  if (sourceType === "whatsapp" || sourceType === "whatsapp_echo") {
    const phone = (sourceUrl.match(/wa\.me\/([^?#]+)/)?.[1] ?? "").replace(/\D/g, "");
    return (
      <button type="button" onClick={() => openWhatsApp(phone || null)} className={cls}>
        <MessageCircle className="h-3 w-3" />{t("facts.source")}
      </button>
    );
  }
  if (sourceType === "sms" || sourceType === "sms_echo") {
    const peer = sourceUrl.startsWith("sms:") ? sourceUrl.slice(4) : "";
    return (
      <button
        type="button"
        onClick={() =>
          router.push(peer ? `/${locale}/sms?chat_id=${encodeURIComponent(peer)}&ts=${Date.now()}` : `/${locale}/sms`)
        }
        className={cls}
      >
        <MessageSquare className="h-3 w-3" />{t("facts.source")}
      </button>
    );
  }
  return (
    <a href={sourceUrl} target="_blank" rel="noreferrer" className={cls}>
      <ExternalLink className="h-3 w-3" />{t("facts.source")}
    </a>
  );
}

export function InfoClient() {
  const t = useTranslations("smrtInfo");

  // ── ask ──────────────────────────────────────────────────────
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AnswerState | null>(null);

  // ── facts ────────────────────────────────────────────────────
  const [tab, setTab] = useState<Scope | "all">("all");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  // ── dialogs ──────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // ── secret suggestions ───────────────────────────────────────
  const [suggestions, setSuggestions] = useState<SecretSuggestion[]>([]);

  // ── context profile ──────────────────────────────────────────
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({ orgs: "", family: "", vendors: "", notes: "" });
  const [profileSaving, setProfileSaving] = useState(false);

  const loadFacts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tab !== "all") params.set("scope", tab);
      if (search.trim()) params.set("q", search.trim());
      const qs = params.toString();
      const { facts } = await api<{ facts: Fact[] }>(`/api/info/facts${qs ? `?${qs}` : ""}`);
      setFacts(facts);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  const loadSuggestions = useCallback(async () => {
    try {
      const { suggestions } = await api<{ suggestions: SecretSuggestion[] }>(
        "/api/info/secret-suggestions?status=pending",
      );
      setSuggestions(suggestions);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => { loadFacts(); }, [loadFacts]);
  useEffect(() => { loadSuggestions(); }, [loadSuggestions]);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await api<AnswerState>("/api/info/ask", { method: "POST", body: { question: q } });
      setAnswer(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }
  function openEdit(f: Fact) {
    setEditingId(f.id);
    setForm({
      entity: f.entity, attribute: f.attribute, value: f.value, scope: f.scope,
      effective_date: f.effective_date ?? "", source_url: f.source_url ?? "",
    });
    setDialogOpen(true);
  }

  async function saveFact() {
    if (!form.entity.trim() || !form.attribute.trim() || !form.value.trim()) {
      toast.error(t("field.required"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        entity: form.entity, attribute: form.attribute, value: form.value, scope: form.scope,
        effective_date: form.effective_date || undefined, source_url: form.source_url || undefined,
      };
      if (editingId) {
        await api(`/api/info/facts/${editingId}`, { method: "PATCH", body });
      } else {
        await api("/api/info/facts", { method: "POST", body });
      }
      toast.success(t("saved"));
      setDialogOpen(false);
      loadFacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function verifyFact(f: Fact) {
    try {
      await api(`/api/info/facts/${f.id}`, { method: "PATCH", body: { verified: true } });
      loadFacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }
  async function assignScope(f: Fact, scope: Scope) {
    try {
      await api(`/api/info/facts/${f.id}`, { method: "PATCH", body: { scope } });
      loadFacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }
  async function deleteFact(f: Fact) {
    if (!confirm(t("deleteConfirm"))) return;
    try {
      await api(`/api/info/facts/${f.id}`, { method: "DELETE" });
      toast.success(t("deleted"));
      loadFacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function approveSecret(s: SecretSuggestion) {
    try {
      await api(`/api/info/secret-suggestions/${s.id}/approve`, { method: "POST", body: {} });
      toast.success(t("secrets.saved"));
      loadSuggestions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }
  async function dismissSecret(s: SecretSuggestion) {
    try {
      await api(`/api/info/secret-suggestions/${s.id}/dismiss`, { method: "POST", body: {} });
      loadSuggestions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function openProfile() {
    try {
      const { profile } = await api<{ profile: Record<string, unknown> }>("/api/info/context-profile");
      const orgs = Array.isArray(profile.orgs) ? (profile.orgs as { name?: string }[]).map((o) => o.name).filter(Boolean).join(", ") : "";
      const family = Array.isArray(profile.family) ? (profile.family as { name?: string }[]).map((f) => f.name).filter(Boolean).join(", ") : "";
      const vendors = Array.isArray(profile.vendors) ? (profile.vendors as string[]).join(", ") : "";
      const notes = typeof profile.notes === "string" ? profile.notes : "";
      setProfileForm({ orgs, family, vendors, notes });
    } catch {
      setProfileForm({ orgs: "", family: "", vendors: "", notes: "" });
    }
    setProfileOpen(true);
  }
  async function saveProfile() {
    setProfileSaving(true);
    try {
      const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const profile = {
        orgs: split(profileForm.orgs).map((name) => ({ name })),
        family: split(profileForm.family).map((name) => ({ name })),
        vendors: split(profileForm.vendors),
        notes: profileForm.notes.trim() || undefined,
      };
      await api("/api/info/context-profile", { method: "PUT", body: { profile } });
      toast.success(t("profile.saved"));
      setProfileOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setProfileSaving(false);
    }
  }

  const scopeLabel = (s: Scope) => t(`scope.${s}`);

  return (
    <div className="space-y-6">
      {/* ── Ask (hero) ─────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <span className="font-medium">{t("ask.title")}</span>
        </div>
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
            placeholder={t("ask.placeholder")}
          />
          <Button onClick={ask} disabled={asking}>
            {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ask.button")}
          </Button>
        </div>

        {answer && (
          <div className="rounded-lg bg-muted/50 p-3 space-y-3 text-sm">
            {answer.answer ? (
              <p className="whitespace-pre-wrap">{answer.answer}</p>
            ) : (
              <p className="text-muted-foreground">{t("ask.empty")}</p>
            )}

            {answer.facts.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("ask.sources")}</div>
                {answer.facts.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline">{scopeLabel(f.scope)}</Badge>
                    <span className="font-medium">{f.entity}</span>
                    <span className="text-muted-foreground">{f.attribute}:</span>
                    <span>{f.value}</span>
                    {f.source_url && (
                      <InfoSourceLink sourceType={f.source_type} sourceUrl={f.source_url} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {answer.vaultMatches.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <KeyRound className="h-3 w-3" />{t("ask.vault")}
                </div>
                {answer.vaultMatches.map((v) => (
                  <div key={v.id} className="text-xs">
                    {v.label}{v.username ? ` — ${v.username}` : ""}
                  </div>
                ))}
                <div className="text-xs text-muted-foreground">{t("ask.vaultHint")}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Secret suggestions ─────────────────────────────────── */}
      {suggestions.length > 0 && (
        <div className="rounded-xl border border-status-warn/40 bg-status-warn/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-status-warn" />{t("secrets.title")}
          </div>
          {suggestions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{s.label}{s.username ? ` — ${s.username}` : ""}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => approveSecret(s)}>{t("secrets.approve")}</Button>
                <Button size="sm" variant="ghost" onClick={() => dismissSecret(s)}>{t("secrets.dismiss")}</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1">
          {TABS.map((tb) => (
            <Button
              key={tb}
              size="sm"
              variant={tab === tb ? "default" : "ghost"}
              onClick={() => setTab(tb)}
            >
              {tb === "all" ? t("tabs.all") : scopeLabel(tb)}
            </Button>
          ))}
        </div>
        <div className="flex-1" />
        {searchOpen ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 w-56"
            />
            <Button size="icon" variant="ghost" onClick={() => { setSearch(""); setSearchOpen(false); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <Button size="icon" variant="ghost" onClick={() => setSearchOpen(true)} title={t("search")}>
            <Search className="h-4 w-4" />
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={openProfile} title={t("profile.button")}>
          <Settings2 className="h-4 w-4" />
        </Button>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4 me-1" />{t("add")}
        </Button>
      </div>

      {/* ── Facts list ─────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : facts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">{t("facts.empty")}</p>
      ) : (
        <div className="space-y-2">
          {facts.map((f) => (
            <div key={f.id} className="rounded-lg border p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline">{scopeLabel(f.scope)}</Badge>
                  {!f.verified && <Badge variant="secondary" className="text-status-warn">{t("facts.unverified")}</Badge>}
                  <span className="font-medium">{f.entity}</span>
                  <span className="text-muted-foreground text-sm">{f.attribute}</span>
                </div>
                <div className="text-sm break-words">{f.value}{f.effective_date ? ` · ${f.effective_date}` : ""}</div>
                {f.source_url && (
                  <InfoSourceLink sourceType={f.source_type} sourceUrl={f.source_url} />
                )}
                {f.scope === "unclassified" && (
                  <div className="flex gap-1 pt-1">
                    <Button size="sm" variant="outline" onClick={() => assignScope(f, "personal")}>{t("scope.personal")}</Button>
                    <Button size="sm" variant="outline" onClick={() => assignScope(f, "org")}>{t("scope.org")}</Button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!f.verified && (
                  <Button size="icon" variant="ghost" onClick={() => verifyFact(f)} title={t("facts.verify")}>
                    <Check className="h-4 w-4" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => openEdit(f)} title={t("edit")}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => deleteFact(f)} title={t("delete")}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add / edit dialog ──────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? t("editTitle") : t("addTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder={t("field.entity")} value={form.entity} onChange={(e) => setForm({ ...form, entity: e.target.value })} />
            <Input placeholder={t("field.attribute")} value={form.attribute} onChange={(e) => setForm({ ...form, attribute: e.target.value })} />
            <Textarea placeholder={t("field.value")} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            <div className="flex gap-2">
              {(["personal", "org", "unclassified"] as Scope[]).map((s) => (
                <Button key={s} type="button" size="sm" variant={form.scope === s ? "default" : "outline"} onClick={() => setForm({ ...form, scope: s })}>
                  {scopeLabel(s)}
                </Button>
              ))}
            </div>
            <Input type="date" value={form.effective_date} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} />
            <Input placeholder={t("field.sourceUrl")} value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>{t("cancel")}</Button>
            <Button onClick={saveFact} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Context profile dialog ─────────────────────────────── */}
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("profile.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("profile.hint")}</p>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t("profile.orgs")}</label>
              <Input value={profileForm.orgs} onChange={(e) => setProfileForm({ ...profileForm, orgs: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium">{t("profile.family")}</label>
              <Input value={profileForm.family} onChange={(e) => setProfileForm({ ...profileForm, family: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium">{t("profile.vendors")}</label>
              <Input value={profileForm.vendors} onChange={(e) => setProfileForm({ ...profileForm, vendors: e.target.value })} />
            </div>
            <div>
              <label className="text-sm font-medium">{t("profile.notes")}</label>
              <Textarea value={profileForm.notes} onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProfileOpen(false)}>{t("cancel")}</Button>
            <Button onClick={saveProfile} disabled={profileSaving}>
              {profileSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
