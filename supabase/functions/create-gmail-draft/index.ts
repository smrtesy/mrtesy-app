import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function refreshGoogleToken(userId: string): Promise<string> {
  const { data: cred } = await supabase
    .from("user_credentials")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .eq("service", "gmail")
    .single();

  if (!cred) throw new Error("No Gmail credentials");

  if (cred.expires_at && new Date(cred.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
    return cred.access_token;
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: cred.refresh_token!,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) throw new Error(`Token refresh: ${resp.status}`);
  const tokens = await resp.json();

  await supabase.from("user_credentials").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("user_id", userId).eq("service", "gmail");

  return tokens.access_token;
}

function createMimeMessage(to: string, subject: string, body: string): string {
  const lines = [];
  if (to) lines.push(`To: ${to}`);
  if (subject) lines.push(`Subject: ${subject}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(body);
  const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n"))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return raw;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const { data: { user } } = await supabaseAuth.auth.getUser(authHeader);
    if (!user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { to, subject, body, task_id } = await req.json();
    if (!body) {
      return new Response(JSON.stringify({ error: "body required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const token = await refreshGoogleToken(user.id);
    const raw = createMimeMessage(to || "", subject || "", body);

    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: { raw },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gmail Drafts API: ${resp.status} ${err}`);
    }

    const draft = await resp.json();
    const draftUrl = `https://mail.google.com/mail/?#drafts/${draft.message?.id}`;

    if (task_id) {
      const { data: task } = await supabase
        .from("tasks")
        .select("ai_generated_content")
        .eq("id", task_id)
        .eq("user_id", user.id)
        .single();

      if (task) {
        const content = task.ai_generated_content || [];
        content.push({
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          action_label: "gmail_draft",
          result: `Draft created${to ? ` for ${to}` : ""}`,
          draft_id: draft.id,
          draft_url: draftUrl,
        });

        await supabase.from("tasks").update({
          ai_generated_content: content,
          updated_at: new Date().toISOString(),
        }).eq("id", task_id);
      }
    }

    return new Response(JSON.stringify({
      draft_id: draft.id,
      draft_url: draftUrl,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
