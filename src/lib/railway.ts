/**
 * Railway GraphQL client — fetch a deployment's build + runtime logs.
 *
 * Used by the Railway deploy webhook (src/app/api/webhooks/railway) so a FAILED
 * deploy's actual error lands in our notification system without anyone opening
 * the Railway dashboard. Read-only; needs RAILWAY_API_TOKEN (an account or team
 * token created in Railway → Settings → Tokens), set on Vercel.
 */

const RAILWAY_GQL = process.env.RAILWAY_GRAPHQL_URL ?? "https://backboard.railway.com/graphql/v2";

interface LogLine {
  timestamp?: string;
  severity?: string;
  message?: string;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) return { error: "RAILWAY_API_TOKEN is not set" };
  try {
    const resp = await fetch(RAILWAY_GQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await resp.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
    if (json.errors?.length) return { error: json.errors.map((e) => e.message).join("; ") };
    if (!resp.ok) return { error: `Railway API ${resp.status}` };
    return { data: json.data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Railway API unreachable" };
  }
}

function formatLines(lines: LogLine[] | undefined, tail: number): string {
  if (!lines?.length) return "";
  return lines
    .slice(-tail)
    .map((l) => `${l.severity ? `[${l.severity}] ` : ""}${(l.message ?? "").trimEnd()}`)
    .filter(Boolean)
    .join("\n");
}

/** Fetch the build log (and runtime log, for crashes) tail for a deployment.
 *  Never throws — returns a human-readable string, including any API error so
 *  the failure reason is visible even if log retrieval itself fails. */
export async function fetchDeploymentLogs(deploymentId: string): Promise<string> {
  const build = await gql<{ buildLogs?: LogLine[] }>(
    `query($id: String!) { buildLogs(deploymentId: $id, limit: 400) { timestamp severity message } }`,
    { id: deploymentId },
  );
  const deploy = await gql<{ deploymentLogs?: LogLine[] }>(
    `query($id: String!) { deploymentLogs(deploymentId: $id, limit: 150) { timestamp severity message } }`,
    { id: deploymentId },
  );

  const parts: string[] = [];
  if (build.error && deploy.error) {
    return `⚠️ Could not fetch Railway logs: ${build.error}`;
  }
  const buildTxt = formatLines(build.data?.buildLogs, 200);
  if (buildTxt) parts.push(`── build log (tail) ──\n${buildTxt}`);
  const deployTxt = formatLines(deploy.data?.deploymentLogs, 80);
  if (deployTxt) parts.push(`── runtime log (tail) ──\n${deployTxt}`);
  if (build.error) parts.push(`(build log unavailable: ${build.error})`);

  return parts.join("\n\n") || "(no log lines returned by Railway)";
}
