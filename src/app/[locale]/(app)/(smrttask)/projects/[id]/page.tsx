export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, CheckCircle2, Tag, User, GitBranch } from "lucide-react";
import { notFound } from "next/navigation";
import { BuildBriefButton } from "@/components/smrttask/tasks/BuildBriefButton";
import { BriefFactVerifier } from "@/components/smrttask/projects/BriefFactVerifier";
import { EditProjectSheet } from "@/components/smrttask/projects/EditProjectSheet";
import { NewProjectButton } from "@/components/smrttask/projects/NewProjectButton";
import { formatDateOnly } from "@/lib/date";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations("projects");
  const tDetail = await getTranslations("projectDetail");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!project) notFound();

  const [briefResult, tasksResult, subProjectsResult] = await Promise.all([
    supabase.from("project_briefs").select("*").eq("project_id", id).single(),
    supabase
      .from("tasks")
      .select("id, title, title_he, priority, status, due_date")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("projects")
      .select("id, name, name_he, color")
      .eq("parent_id", id)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true }),
  ]);

  const brief = briefResult.data;
  const tasks = tasksResult.data || [];
  const subProjects = subProjectsResult.data || [];
  const name = locale === "he" && project.name_he ? project.name_he : project.name;

  const pendingFacts = (brief?.pending_facts as Array<{
    id: string;
    type: "contact" | "keyword" | "timeline" | "link" | "topic" | "note";
    value: string;
    extracted_at: string;
  }> | null) ?? [];

  const verifiedFacts = (brief?.verified_facts as Array<{
    id: string;
    type: string;
    value: string;
  }> | null) ?? [];

  const keywords = (project.keywords as string[] | null) ?? [];
  const keyContacts = (project.key_contacts as string[] | null) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {project.color && (
            <span className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: project.color as string }} />
          )}
          <h1 className="text-2xl font-bold truncate">{name}</h1>
        </div>
        <EditProjectSheet
          project={{
            id: project.id,
            name: project.name,
            name_he: project.name_he as string | null,
            color: project.color as string | null,
            keywords: project.keywords as string[] | null,
            key_contacts: project.key_contacts as string[] | null,
          }}
          brief={brief ? {
            id: brief.id as string,
            purpose: brief.purpose as string | null,
            target_audience: brief.target_audience as string | null,
            current_status: brief.current_status as string | null,
            ai_context: brief.ai_context as string | null,
          } : null}
          locale={locale}
        />
      </div>

      {/* Keywords + Contacts chips */}
      {(keywords.length > 0 || keyContacts.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {keywords.map((kw) => (
            <Badge key={kw} variant="secondary" className="gap-1 text-xs">
              <Tag className="h-3 w-3" />
              {kw}
            </Badge>
          ))}
          {keyContacts.map((c) => (
            <Badge key={c} variant="outline" className="gap-1 text-xs">
              <User className="h-3 w-3" />
              {c}
            </Badge>
          ))}
        </div>
      )}

      {/* Pending facts — verify one by one */}
      {pendingFacts.length > 0 && brief && (
        <BriefFactVerifier
          projectId={id}
          briefId={brief.id as string}
          pendingFacts={pendingFacts}
          locale={locale}
        />
      )}

      {/* Project Brief */}
      {brief ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{t("brief")}</CardTitle>
              <BuildBriefButton projectName={name} projectId={id} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {brief.purpose && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t("purpose")}</p>
                <p className="text-sm">{brief.purpose as string}</p>
              </div>
            )}
            {brief.target_audience && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t("targetAudience")}</p>
                <p className="text-sm">{brief.target_audience as string}</p>
              </div>
            )}
            {brief.current_status && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t("status")}</p>
                <p className="text-sm">{brief.current_status as string}</p>
              </div>
            )}
            {brief.ai_context && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t("aiContext")}</p>
                <p className="text-xs text-muted-foreground">{brief.ai_context as string}</p>
              </div>
            )}

            {/* Verified facts */}
            {verifiedFacts.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {tDetail("verifiedFacts")} ({verifiedFacts.length})
                </p>
                <div className="space-y-1">
                  {verifiedFacts.map((fact) => (
                    <div key={fact.id} className="flex items-center gap-2 text-xs">
                      <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                      <Badge variant="outline" className="text-[10px]">{fact.type}</Badge>
                      <span dir="auto">{fact.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {brief.important_links && (brief.important_links as Array<{name: string; url: string}>).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">{t("links")}</p>
                {(brief.important_links as Array<{name: string; url: string}>).map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {link.name}
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground mb-3">{t("noBrief")}</p>
            <BuildBriefButton projectName={name} projectId={id} />
          </CardContent>
        </Card>
      )}

      {/* Sub-projects */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            {tDetail("subProjects")}
            {subProjects.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">({subProjects.length})</span>
            )}
          </h2>
          <NewProjectButton locale={locale} label={tDetail("addSubProject")} parentId={id} />
        </div>
        {subProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tDetail("noSubProjects")}</p>
        ) : (
          <div className="space-y-1.5">
            {subProjects.map((sub) => {
              const subName = locale === "he" && sub.name_he ? sub.name_he : sub.name;
              return (
                <a
                  key={sub.id}
                  href={`/${locale}/projects/${sub.id}`}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2.5 hover:bg-accent/50 transition-colors"
                >
                  {sub.color && (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: sub.color as string }}
                    />
                  )}
                  <span className="text-sm font-medium">{subName}</span>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {/* Linked Tasks */}
      <div>
        <h2 className="text-lg font-semibold mb-3">{t("title")} ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProjects")}</p>
        ) : (
          <div className="space-y-1">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between rounded border p-3">
                <span className="text-sm truncate flex-1">
                  {locale === "he" && task.title_he ? task.title_he : task.title}
                </span>
                <div className="flex items-center gap-2">
                  {task.due_date && (
                    <span className="text-xs text-muted-foreground">
                      {formatDateOnly(task.due_date as string, locale)}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px]">{task.priority}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
