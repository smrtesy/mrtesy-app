---
paths:
  - "supabase/functions/**"
---

# Edge function imports — NEVER use `https://esm.sh/...`

The `Deploy to Supabase` GitHub Action (`.github/workflows/deploy-supabase.yml`)
bundles every function on each push to `main` by hitting esm.sh, which
intermittently returns HTTP 522 (Cloudflare Tunnel down) and breaks the whole
deploy with `Error: failed to create the graph` /
`Import 'https://esm.sh/...' failed: 522`. Use the Deno-native specifiers
Supabase Edge Runtime supports directly instead:

- Supabase client → `import { createClient } from "npm:@supabase/supabase-js@2";`
- Type-only edge runtime decl → `import "jsr:@supabase/functions-js/edge-runtime.d.ts";`
- Anthropic SDK / Google APIs → `npm:@anthropic-ai/sdk`, `npm:googleapis`, etc.

This bug has bitten us twice; if you ever see `Error: failed to create the
graph ... Import 'https://esm.sh/... failed: 522`, the fix is a one-line `sed`
across `supabase/functions/*/index.ts`.

Also remember: edge functions read secrets from **Supabase secrets** (not
Railway), and shared code lives in `supabase/functions/_shared/` — the Deno
copy of `rule-filters.ts` there must stay in sync with
`server/src/modules/smrttask/lib/rule-filters.ts`.
