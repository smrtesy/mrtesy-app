import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

export default async function TasksPage() {
  const t = await getTranslations("tasks");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user!.id)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">
        {tasks?.length || 0} {t("active").toLowerCase()}
      </p>
      {/* TaskList component will be added in Step 8 */}
      {(!tasks || tasks.length === 0) && (
        <div className="mt-8 text-center text-muted-foreground">
          <p>No tasks yet. They will appear here after AI processes your messages.</p>
        </div>
      )}
    </div>
  );
}
