import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

export const db = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ── Helper: load active rules for a user ─────────────────────────────────────
export async function loadRules(userId: string) {
  const { data, error } = await db
    .from("rules_memory")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) throw new Error(`loadRules: ${error.message}`);
  return data ?? [];
}

// ── Helper: create a run session ─────────────────────────────────────────────
export async function createRunSession(
  userId: string,
  part: string,
  runType: string,
  modelUsed?: string,
) {
  const title = `${part.toUpperCase()} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const { data, error } = await db
    .from("run_sessions")
    .insert({
      user_id: userId,
      run_title: title,
      run_type: runType,
      part,
      status: "running",
      model_used: modelUsed ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`createRunSession: ${error.message}`);
  return data.id as string;
}

// ── Helper: close a run session ───────────────────────────────────────────────
export async function closeRunSession(
  sessionId: string,
  status: "completed" | "partial" | "failed",
  counts: {
    items_processed?: number;
    items_skipped?: number;
    tasks_created?: number;
    tasks_updated?: number;
    actionable_count?: number;
    informational_count?: number;
    rules_added?: number;
    errors_count?: number;
  },
  summary?: string,
  errorsLog?: unknown[],
) {
  const startedAt = await db
    .from("run_sessions")
    .select("started_at")
    .eq("id", sessionId)
    .single()
    .then((r) => r.data?.started_at);

  const endedAt = new Date().toISOString();
  const durationSeconds = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)
    : null;

  await db
    .from("run_sessions")
    .update({
      status,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      summary,
      errors_log: errorsLog ?? [],
      ...counts,
    })
    .eq("id", sessionId);
}

// ── Helper: upsert sync_state checkpoint ─────────────────────────────────────
export async function updateSyncState(
  userId: string,
  source: string,
  checkpoint: string | null,
  extra?: { last_error?: string; consecutive_failures?: number },
) {
  await db.from("sync_state").upsert(
    {
      user_id: userId,
      source,
      checkpoint,
      last_synced_at: new Date().toISOString(),
      ...extra,
    },
    { onConflict: "user_id,source" },
  );
}

// ── Helper: get OAuth credentials for a user ─────────────────────────────────
export async function getCredentials(userId: string, service: string) {
  const { data, error } = await db
    .from("user_credentials")
    .select("*")
    .eq("user_id", userId)
    .eq("service", service)
    .single();

  if (error) return null;
  return data;
}
