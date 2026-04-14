import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { BuildBriefButton } from "@/components/tasks/BuildBriefButton";

export default async function ProjectDetailPage({
  params: { locale, id },
}: {
  params: { locale: string; id: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .eq("user_id", user?.id || "")
    .single();

  if (!project) notFound();

  const [briefResult, tasksResult] = await Promise.all([
    supabase.from("project_briefs").select("*").eq("project_id", id).single(),
    supabase
      .from("tasks")
      .select("id, title, title_he, priority, status, due_date")
      .eq("project_id", id)
      .eq("user_id", user?.id || "")
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const brief = briefResult.data;
  const tasks = tasksResult.data || [];
  const name = locale === "he" && project.name_he ? project.name_he : project.name;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {project.color && (
          <span className="h-4 w-4 rounded-full" style={{ backgroundColor: project.color }} />
        )}
        <h1 className="text-2xl font-bold">{name}</h1>
      </div>

      {/* Brief */}
      {brief ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Project Brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {brief.purpose && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">Purpose</p>
                <p className="text-sm">{brief.purpose}</p>
              </div>
            )}
            {brief.target_audience && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">Target Audience</p>
                <p className="text-sm">{brief.target_audience}</p>
              </div>
            )}
            {brief.current_status && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">Status</p>
                <p className="text-sm">{brief.current_status}</p>
              </div>
            )}
            {brief.ai_context && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">AI Context</p>
                <p className="text-xs text-muted-foreground">{brief.ai_context}</p>
              </div>
            )}
            {brief.important_links && (brief.important_links as Array<{name: string; url: string}>).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Links</p>
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
            <p className="text-sm text-muted-foreground">No brief yet</p>
            <BuildBriefButton projectName={name} />
          </CardContent>
        </Card>
      )}

      {/* Tasks */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks in this project</p>
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
                      {new Date(task.due_date).toLocaleDateString()}
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
