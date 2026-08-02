# In-app Claude connectors — Google Drive & Canva

Gives the in-app Claude console (`/claude`) real, full read+write access to
**Google Drive** and **Canva** as MCP tools it can call during a run.

## Why our own MCP servers (not the official remote ones)

Both vendors ship an official *remote* MCP server
(`drivemcp.googleapis.com`, `mcp.canva.com`), but both require an
**interactive browser OAuth** on first connect and document no bearer-token /
header path for headless use. Our runner is headless and non-interactive
(`claude -p` on Railway) — there is no browser to complete that consent at run
time. So instead of the hosted servers we run **two small stdio MCP servers of
our own** and hand each one a token minted per turn.

Everything lives in `server/src/modules/claude/mcp/`:

| File | Role |
|---|---|
| `stdio-server.ts` | Dependency-free MCP-over-stdio engine (initialize / tools/list / tools/call). Hand-rolled because `@modelcontextprotocol/sdk` is ESM-exports-only and won't type-check under the server's `node10` module resolution. Wire format (newline-delimited JSON-RPC) verified against the SDK's own transport. |
| `gdrive-server.ts` | Google Drive tools (full read+write) over the Drive REST v3 API. |
| `canva-server.ts` | Canva tools (read+write) over the Canva Connect REST API. |
| `rest.ts` | Tiny non-throwing fetch helper — API errors are shown to the model, not hidden. |
| `connectors.ts` | Mints the per-turn tokens and builds `--mcp-config`. |

The runner (`runner.ts`) mints tokens right after app-access, injects them into
the child env, and — only for the connectors that produced a token — adds
`--mcp-config <inline json>` plus a server-level `--allowedTools mcp__<server>`
(the same way `WebSearch`/`WebFetch` are allowed). A connector with no token is
simply never registered, so an unconfigured connector is silently absent, never
a failed turn. The access tokens are scrubbed from the stored event log.

## Google Drive — zero setup

The Drive connector **reuses the OAuth grant the launching user already gave the
platform** (`user_credentials`, service `google_drive`), which carries the full
`https://www.googleapis.com/auth/drive` scope. `mintDriveToken(userId)` calls
`getOAuthClient(userId,"drive")` (proactive refresh + persist) and hands the
access token to the Drive server. Nothing to configure — if the user connected
Drive in the app, the console can use it as that user.

**Tools:** `drive_search`, `drive_get`, `drive_read` (Google Docs/Sheets/Slides
auto-exported to text/CSV), `drive_create`, `drive_update`, `drive_trash`,
`drive_create_folder`, `drive_share`, and `drive_request` (raw REST escape
hatch). Per-user: the run acts as the user who opened the chat, no wider.

## Canva — one shared account, one-time setup

Canva is a single shared Connect account. A rotating refresh token lives in
`app_secrets` under slug `smrtstudio`; `mintCanvaToken()` exchanges it for an
access token cached process-wide (~4h) so we don't churn Canva's rotating
refresh tokens on every run, and persists the rotated refresh token back to the
vault.

### One-time authorization

1. In the Canva Developer portal (**https://www.canva.com/developers/integrations**)
   create an integration. Copy its **Client ID** and generate a **Client
   secret**.
2. Add the redirect URL **`http://127.0.0.1:8910/callback`**.
3. Grant these scopes: `design:content:read design:content:write
   design:meta:read asset:read asset:write folder:read folder:write
   brandtemplate:meta:read brandtemplate:content:read profile:read`.
4. Run the helper locally and approve in the browser:
   ```
   CANVA_CLIENT_ID=xxx CANVA_CLIENT_SECRET=yyy node server/scripts/canva-connect.mjs
   ```
5. Store the three values it prints in **`/admin/apps/smrtstudio/secrets`**:
   `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REFRESH_TOKEN` (mark the
   secret ones as secret). Done — the backend refreshes access tokens on its own.

**Tools:** `canva_whoami`, `canva_list_designs`, `canva_get_design`,
`canva_create_design`, `canva_export_design`, `canva_list_folder_items`,
`canva_list_brand_templates`, `canva_get_brand_template_dataset`,
`canva_autofill`, `canva_url_import`, and `canva_request` (raw REST escape
hatch). Export/autofill/URL-import are async jobs the server polls to completion.

**Honest limitation:** the Connect REST API creates blank/preset designs, fills
brand templates (autofill), imports files, and exports — it does **not** generate
a design from a free-text prompt. That generative feature is exclusive to Canva's
own hosted MCP server, which needs interactive OAuth and can't run headless here.

## Safety

The environment preamble tells the run the same rule that already governs the
app API and the browser helper: **read/search freely; write, change, or delete
only when the user explicitly asked in the chat.** Under repo runs'
`bypassPermissions` these tools carry no separate gate, so that instruction is
the control — matching how the console already treats the user's own app data.
