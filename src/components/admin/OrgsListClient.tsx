"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Users, Layers, ExternalLink, Plus, X } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

interface AdminOrg {
  id: string;
  slug: string;
  name: string;
  name_he: string | null;
  created_at: string;
  member_count: number;
  apps_enabled: string[];
  owner_user_id: string | null;
  owner_email: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
}

function CreateOrgDialog({
  onCreated,
  onClose,
}: {
  onCreated: (org: AdminOrg) => void;
  onClose: () => void;
}) {
  const t = useTranslations("admin");
  const [name, setName] = useState("");
  const [nameHe, setNameHe] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManual, setSlugManual] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!slugManual && name) setSlug(slugify(name));
  }, [name, slugManual]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const { org } = await api<{ org: AdminOrg }>("/api/admin/orgs", {
        method: "POST",
        body: { name: name.trim(), name_he: nameHe.trim() || undefined, slug: slug.trim() || undefined },
        noOrg: true,
      });
      toast.success(t("createOrgSuccess"));
      onCreated(org);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(t("createOrgSlugTaken"));
      } else {
        toast.error(t("createOrgError"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background rounded-xl border shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-base font-semibold">{t("createOrgTitle")}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("createOrgNameEn")} *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded border px-3 py-2 text-sm bg-background"
              placeholder="Acme Corp"
              dir="ltr"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("createOrgNameHe")}</label>
            <input
              type="text"
              value={nameHe}
              onChange={(e) => setNameHe(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm bg-background"
              placeholder="אקמי קורפ"
              dir="rtl"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("createOrgSlug")}</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugManual(true); }}
              className="w-full rounded border px-3 py-2 text-sm bg-background font-mono"
              placeholder="acme-corp"
              dir="ltr"
            />
            <p className="text-xs text-muted-foreground">{t("createOrgSlugHint")}</p>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t("cancel") || "Cancel"}
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? "..." : t("createOrgSubmit")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function OrgsListClient({ locale }: { locale: string }) {
  const t = useTranslations("admin");
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const fetchOrgs = useCallback(async () => {
    try {
      const { orgs } = await api<{ orgs: AdminOrg[] }>("/api/admin/orgs", { noOrg: true });
      setOrgs(orgs ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        toast.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  const filtered = search.trim()
    ? orgs.filter((o) =>
        o.name.toLowerCase().includes(search.toLowerCase())
        || o.slug.toLowerCase().includes(search.toLowerCase())
        || (o.owner_email ?? "").toLowerCase().includes(search.toLowerCase()))
    : orgs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6" />
          {t("organizationsTitle")} <span className="text-muted-foreground text-base">({orgs.length})</span>
        </h1>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder={t("searchOrgs")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded border px-3 py-1.5 text-sm bg-background w-56"
          />
          <Button size="sm" className="gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            {t("createOrg")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {orgs.length === 0 ? t("noOrgs") : t("noMatches")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => (
            <Card key={o.id} className="hover:bg-accent/30 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base flex items-center gap-2 min-w-0">
                    <Link
                      href={`/${locale}/admin/orgs/${o.id}`}
                      className="hover:underline truncate"
                      dir="auto"
                    >
                      {o.name}
                    </Link>
                    <span className="text-xs font-normal text-muted-foreground font-mono">
                      {o.slug}
                    </span>
                  </CardTitle>
                  <Link
                    href={`/${locale}/admin/orgs/${o.id}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {t("memberCount", { count: o.member_count })}
                  </span>
                  {o.owner_email && (
                    <span className="truncate max-w-[200px]">{t("ownerLabel")}: {o.owner_email}</span>
                  )}
                  <span className="flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {o.apps_enabled.length === 0
                      ? <span className="italic">{t("noAppsLabel")}</span>
                      : o.apps_enabled.map((slug) => (
                        <Badge key={slug} variant="outline" className="text-[10px]">{slug}</Badge>
                      ))
                    }
                  </span>
                  <span className="ms-auto">
                    {new Date(o.created_at).toLocaleDateString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateOrgDialog
          onCreated={(org) => {
            setOrgs((prev) => [{ ...org, member_count: 0, apps_enabled: [], owner_user_id: null, owner_email: null }, ...prev]);
            setShowCreate(false);
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
