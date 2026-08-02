#!/usr/bin/env node
/**
 * Canva MCP server (stdio) for the in-app Claude console.
 *
 * A STANDALONE process, like the Drive server. The runner injects
 * SMRTESY_CANVA_TOKEN — a fresh Canva Connect access token minted per turn from
 * the shared refresh token stored in app_secrets (slug smrtstudio) — and
 * registers this compiled file as an MCP server via --mcp-config. The Claude
 * engine launches it with `node <path>` and speaks MCP over stdio.
 *
 * It calls the Canva Connect REST API (https://api.canva.com/rest/v1, verified
 * 2026-08) directly with the bearer token. Several operations (export, autofill,
 * URL import) are asynchronous JOB APIs: create the job, then poll the matching
 * GET endpoint until it leaves `in_progress`. pollJob() handles that.
 *
 * NOTE (honest limitation): the Connect REST API creates blank/preset designs,
 * fills brand templates (autofill), imports external files, and exports — it
 * does NOT generate a design from a free-text prompt (that generative feature is
 * exclusive to Canva's own hosted MCP server, which needs interactive OAuth and
 * so can't run headless here). canva_create_design makes a design of a given
 * type/preset; use autofill to populate a brand template with data.
 */

import { runStdioServer, type McpTool } from "./stdio-server";
import { restRequest, formatResult, reqStr, optStr, type RestResult } from "./rest";

const TOKEN = process.env.SMRTESY_CANVA_TOKEN ?? "";
const API = "https://api.canva.com/rest/v1";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an async job GET endpoint until its status leaves "in_progress" or we hit
 * the time budget. Canva job responses wrap the state in a top-level `job`
 * object with a `status` of in_progress | success | failed. Returns the final
 * RestResult so the caller shows the model the real body (urls, design, error).
 */
async function pollJob(jobUrl: string, maxWaitMs = 40000, intervalMs = 2500): Promise<RestResult> {
  const deadline = Date.now() + maxWaitMs;
  let last = await restRequest(jobUrl, { headers: authHeaders() });
  while (last.ok) {
    const status = (last.json as { job?: { status?: string } })?.job?.status;
    if (status !== "in_progress") return last;
    if (Date.now() >= deadline) return last; // return the latest in-progress state
    await sleep(intervalMs);
    last = await restRequest(jobUrl, { headers: authHeaders() });
  }
  return last;
}

const tools: McpTool[] = [
  {
    name: "canva_whoami",
    description: "Return the connected Canva account (user id, team id). Use to confirm the connection works.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => formatResult("canva_whoami", await restRequest(`${API}/users/me`, { headers: authHeaders() })),
  },
  {
    name: "canva_list_designs",
    description: "List designs in the connected Canva account. Optional free-text query and pagination continuation token.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over design titles." },
        continuation: { type: "string", description: "Pagination token from a previous response." },
        ownership: { type: "string", enum: ["any", "owned", "shared"], description: "Filter by ownership (default any)." },
        sort_by: { type: "string", enum: ["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"] },
      },
    },
    handler: async (args) => {
      const p = new URLSearchParams();
      const q = optStr(args, "query");
      const cont = optStr(args, "continuation");
      const own = optStr(args, "ownership");
      const sort = optStr(args, "sort_by");
      if (q) p.set("query", q);
      if (cont) p.set("continuation", cont);
      if (own) p.set("ownership", own);
      if (sort) p.set("sort_by", sort);
      const qs = p.toString();
      return formatResult("canva_list_designs", await restRequest(`${API}/designs${qs ? "?" + qs : ""}`, { headers: authHeaders() }));
    },
  },
  {
    name: "canva_get_design",
    description: "Get a single design's metadata (title, urls, thumbnail, page count) by id.",
    inputSchema: { type: "object", properties: { design_id: { type: "string" } }, required: ["design_id"] },
    handler: async (args) =>
      formatResult("canva_get_design", await restRequest(`${API}/designs/${encodeURIComponent(reqStr(args, "design_id"))}`, { headers: authHeaders() })),
  },
  {
    name: "canva_create_design",
    description:
      "Create a new design. Either a preset type (preset_name = doc | whiteboard | presentation) OR custom dimensions (width + height in px). Optionally seed it from an uploaded asset (asset_id) and set a title. Does NOT generate art from a text prompt — see this server's note; use autofill for template-driven content.",
    inputSchema: {
      type: "object",
      properties: {
        preset_name: { type: "string", enum: ["doc", "whiteboard", "presentation"], description: "Preset design type." },
        width: { type: "number", description: "Custom width in px (with height)." },
        height: { type: "number", description: "Custom height in px (with width)." },
        asset_id: { type: "string", description: "Seed the design from a previously uploaded asset." },
        title: { type: "string" },
      },
    },
    handler: async (args) => {
      const preset = optStr(args, "preset_name");
      const width = Number(args.width);
      const height = Number(args.height);
      let designType: Record<string, unknown> | undefined;
      if (preset) designType = { type: "preset", name: preset };
      else if (width > 0 && height > 0) designType = { type: "custom", width, height };
      const body: Record<string, unknown> = {};
      if (designType) body.design_type = designType;
      const asset = optStr(args, "asset_id");
      const title = optStr(args, "title");
      if (asset) body.asset_id = asset;
      if (title) body.title = title;
      if (!body.design_type && !body.asset_id) {
        throw new Error("Provide preset_name, or width+height, or asset_id — at least one is required.");
      }
      return formatResult(
        "canva_create_design",
        await restRequest(`${API}/designs`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        }),
      );
    },
  },
  {
    name: "canva_export_design",
    description:
      "Export a design to a file and return download URL(s). format: pdf | png | jpg | gif | pptx | mp4. Waits for the async export job to finish (up to ~40s) and returns the resulting urls; if it is still processing, returns the job id to poll later.",
    inputSchema: {
      type: "object",
      properties: {
        design_id: { type: "string" },
        format: { type: "string", enum: ["pdf", "png", "jpg", "gif", "pptx", "mp4"] },
      },
      required: ["design_id", "format"],
    },
    handler: async (args) => {
      const designId = reqStr(args, "design_id");
      const format = reqStr(args, "format");
      const create = await restRequest(`${API}/exports`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ design_id: designId, format: { type: format } }),
      });
      if (!create.ok) return formatResult("canva_export_design (create)", create);
      const jobId = (create.json as { job?: { id?: string } })?.job?.id;
      if (!jobId) return formatResult("canva_export_design", create);
      return formatResult("canva_export_design", await pollJob(`${API}/exports/${encodeURIComponent(jobId)}`));
    },
  },
  {
    name: "canva_list_folder_items",
    description: "List items (designs, images, folders) inside a folder. Use folder_id \"root\" for the top level.",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "Folder id, or \"root\" for the top level." },
        continuation: { type: "string" },
      },
      required: ["folder_id"],
    },
    handler: async (args) => {
      const folder = reqStr(args, "folder_id");
      const cont = optStr(args, "continuation");
      const url = `${API}/folders/${encodeURIComponent(folder)}/items${cont ? "?continuation=" + encodeURIComponent(cont) : ""}`;
      return formatResult("canva_list_folder_items", await restRequest(url, { headers: authHeaders() }));
    },
  },
  {
    name: "canva_list_brand_templates",
    description: "List brand templates available to the connected account (requires a Canva Enterprise plan). Optional free-text query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        continuation: { type: "string" },
      },
    },
    handler: async (args) => {
      const p = new URLSearchParams();
      const q = optStr(args, "query");
      const cont = optStr(args, "continuation");
      if (q) p.set("query", q);
      if (cont) p.set("continuation", cont);
      const qs = p.toString();
      return formatResult("canva_list_brand_templates", await restRequest(`${API}/brand-templates${qs ? "?" + qs : ""}`, { headers: authHeaders() }));
    },
  },
  {
    name: "canva_get_brand_template_dataset",
    description: "Get the fillable fields (dataset) of a brand template, so you know which keys canva_autofill accepts.",
    inputSchema: { type: "object", properties: { brand_template_id: { type: "string" } }, required: ["brand_template_id"] },
    handler: async (args) =>
      formatResult(
        "canva_get_brand_template_dataset",
        await restRequest(`${API}/brand-templates/${encodeURIComponent(reqStr(args, "brand_template_id"))}/dataset`, { headers: authHeaders() }),
      ),
  },
  {
    name: "canva_autofill",
    description:
      "Create a new design by autofilling a brand template with data. `data` is an object keyed by the template's field names (see canva_get_brand_template_dataset), each value shaped per Canva's autofill spec, e.g. {\"headline\":{\"type\":\"text\",\"text\":\"Hello\"}}. Waits for the async job and returns the new design.",
    inputSchema: {
      type: "object",
      properties: {
        brand_template_id: { type: "string" },
        data: { type: "object", description: "Field-name → autofill value map, per the template dataset." },
        title: { type: "string" },
      },
      required: ["brand_template_id", "data"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        brand_template_id: reqStr(args, "brand_template_id"),
        data: args.data ?? {},
      };
      const title = optStr(args, "title");
      if (title) body.title = title;
      const create = await restRequest(`${API}/autofills`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!create.ok) return formatResult("canva_autofill (create)", create);
      const jobId = (create.json as { job?: { id?: string } })?.job?.id;
      if (!jobId) return formatResult("canva_autofill", create);
      return formatResult("canva_autofill", await pollJob(`${API}/autofills/${encodeURIComponent(jobId)}`));
    },
  },
  {
    name: "canva_url_import",
    description:
      "Import an external file (by URL) into Canva as a new design — e.g. a pptx/pdf/docx link. Waits for the async import job and returns the created design.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        url: { type: "string", description: "Public URL of the file to import." },
      },
      required: ["title", "url"],
    },
    handler: async (args) => {
      const create = await restRequest(`${API}/url-imports`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: reqStr(args, "title"), url: reqStr(args, "url") }),
      });
      if (!create.ok) return formatResult("canva_url_import (create)", create);
      const jobId = (create.json as { job?: { id?: string } })?.job?.id;
      if (!jobId) return formatResult("canva_url_import", create);
      return formatResult("canva_url_import", await pollJob(`${API}/url-imports/${encodeURIComponent(jobId)}`));
    },
  },
  {
    name: "canva_request",
    description:
      "Escape hatch: call any Canva Connect REST endpoint directly when no specific tool fits. path is appended to https://api.canva.com/rest/v1 (e.g. \"/assets/ID\"). body is sent as JSON for non-GET methods.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string", description: "Path under /rest/v1, must start with /." },
        query: { type: "string", description: "Raw query string without the leading ? (optional)." },
        body: { type: "object", description: "JSON body for write methods (optional)." },
      },
      required: ["path"],
    },
    handler: async (args) => {
      const method = (optStr(args, "method") ?? "GET").toUpperCase();
      const path = reqStr(args, "path");
      const query = optStr(args, "query");
      const url = `${API}${path.startsWith("/") ? path : "/" + path}${query ? "?" + query : ""}`;
      const hasBody = method !== "GET" && method !== "DELETE" && args.body !== undefined;
      return formatResult(
        `canva_request ${method} ${path}`,
        await restRequest(url, {
          method,
          headers: authHeaders(hasBody ? { "Content-Type": "application/json" } : undefined),
          body: hasBody ? JSON.stringify(args.body) : undefined,
        }),
      );
    },
  },
];

if (!TOKEN) {
  console.error("[mcp:canva] SMRTESY_CANVA_TOKEN is not set — Canva tools will fail.");
}
runStdioServer({ name: "canva", version: "1.0.0" }, tools);
