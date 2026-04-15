export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { FolderOpen } from "lucide-react";
import { NewProjectButton } from "@/components/projects/NewProjectButton";

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("projects");
  const tc = await getTranslations("common");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const { data: projects } = await supabase
    .from("projects")
    .select("*, project_briefs(id, purpose, current_status)")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const { data: taskCounts } = await supabase
    .from("tasks")
    .select("project_id")
    .eq("user_id", user.id)
    .not("project_id", "is", null)
    .neq("status", "archived");

  const countMap: Record<string, number> = {};
  for (const item of taskCounts || []) {
    countMap[item.project_id] = (countMap[item.project_id] || 0) + 1;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-start">{t("title")}</h1>
        <NewProjectButton locale={locale} label={tc("new")} />
      </div>

      {(!projects || projects.length === 0) ? (
        <div className="py-12 text-center text-muted-foreground">
          <FolderOpen className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>{t("noProjects")}</p>
          <p className="text-xs mt-1">{t("createOrWait")}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((project) => {
            const brief = Array.isArray(project.project_briefs)
              ? project.project_briefs[0]
              : project.project_briefs;
            const openTasks = countMap[project.id] || 0;
            const name = locale === "he" && project.name_he ? project.name_he : project.name;

            return (
              <Link key={project.id} href={`/${locale}/projects/${project.id}`}>
                <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {project.color && (
                          <span
                            className="inline-block h-3 w-3 rounded-full me-2"
                            style={{ backgroundColor: project.color }}
                          />
                        )}
                        {name}
                      </CardTitle>
                      {openTasks > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {openTasks} {tc("tasks")}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {brief?.purpose ? (
                      <p className="text-xs text-muted-foreground line-clamp-2">{brief.purpose}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">{t("noBrief")}</p>
                    )}
                    {brief?.current_status && (
                      <Badge variant="outline" className="mt-2 text-[10px]">
                        {brief.current_status}
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
