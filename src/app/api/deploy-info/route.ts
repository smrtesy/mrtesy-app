// Frontend deploy info — commit SHA + boot time from Vercel build env vars.
// Used by /settings to show the user that they're on the latest deploy.
//
// VERCEL_GIT_COMMIT_SHA, VERCEL_DEPLOYMENT_ID, VERCEL_GIT_COMMIT_REF and
// VERCEL_GIT_COMMIT_MESSAGE are automatically injected by Vercel at build
// time. Locally these are unset; we return null and the UI shows "dev".
//
// `force-dynamic` so the response always reflects the current process —
// not a cached value from a prior deploy. boot_at is captured at module
// load: on a warm serverless instance it's the time of the first request
// to land on that instance after this code was deployed; cold starts get
// a fresh value. Either way it's a useful staleness signal.

export const dynamic = "force-dynamic";

const FRONTEND_BOOT_AT = new Date().toISOString();

export async function GET() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  return Response.json({
    commit:         commit || null,
    commit_short:   commit ? commit.slice(0, 7) : null,
    branch:         process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commit_message: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
    deployment_id:  process.env.VERCEL_DEPLOYMENT_ID ?? null,
    env:            process.env.VERCEL_ENV ?? null,
    boot_at:        FRONTEND_BOOT_AT,
  });
}
