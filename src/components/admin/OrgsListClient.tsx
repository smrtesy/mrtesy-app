"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Users, Layers, ExternalLink } from "lucide-react";
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

export function OrgsListClient({ locale }: { locale: string }) {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
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
    })();
  }, []);

  const filtered = search.trim()
    ? orgs.filter((o) =>
        o.name.toLowerCase().includes(search.toLowerCase())
        || o.slug.toLowerCase().includes(search.toLowerCase())
        || (o.owner_email ?? "").toLowerCase().includes(search.toLowerCase()))
    : orgs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6" />
          Organizations <span className="text-muted-foreground text-base">({orgs.length})</span>
        </h1>
        <input
          type="search"
          placeholder="Search name, slug, or owner email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border px-3 py-1.5 text-sm bg-background w-72"
        />
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {orgs.length === 0 ? "No organizations yet." : "No matches."}
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
                    {o.member_count} member{o.member_count === 1 ? "" : "s"}
                  </span>
                  {o.owner_email && (
                    <span className="truncate max-w-[200px]">owner: {o.owner_email}</span>
                  )}
                  <span className="flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {o.apps_enabled.length === 0
                      ? <span className="italic">no apps</span>
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
    </div>
  );
}
