#!/usr/bin/env node
/**
 * Google Drive MCP server (stdio) for the in-app Claude console.
 *
 * A STANDALONE process, not part of the backend: the runner injects
 * SMRTESY_GDRIVE_TOKEN (a fresh OAuth access token for the launching user's
 * Google Drive, minted per turn from the token they already granted the
 * platform) and registers this compiled file as an MCP server via --mcp-config.
 * The Claude engine launches it with `node <path>` and speaks MCP over stdio.
 *
 * The token carries the full `https://www.googleapis.com/auth/drive` scope
 * (verified from the platform's OAuth request in src/app/api/auth/google/
 * route.ts), so this server offers full read AND write. It calls the Drive REST
 * v3 API directly with the bearer token — no googleapis SDK in the subprocess.
 *
 * If the token is absent (the user never connected Drive), the runner simply
 * does not register this server, so it is never launched without credentials.
 */

import { runStdioServer, type McpTool } from "./stdio-server";
import { restRequest, formatResult, reqStr, optStr } from "./rest";

const TOKEN = process.env.SMRTESY_GDRIVE_TOKEN ?? "";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// Shared-drive support on every read: without these two, files that live in a
// Shared Drive are invisible even with a valid scope.
const SHARED = "supportsAllDrives=true&includeItemsFromAllDrives=true";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink,owners(displayName,emailAddress),trashed";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

// Google-native types can't be downloaded raw — they must be exported. Map each
// to a sensible text export; everything else downloads via alt=media.
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const tools: McpTool[] = [
  {
    name: "drive_search",
    description:
      "Search Google Drive files. Provide a raw Drive `query` (Drive query syntax, e.g. \"name contains 'budget' and mimeType='application/pdf'\"), or the convenience fields name_contains / mime_type / in_folder which are combined into a query. Returns id, name, mimeType, modifiedTime, size, webViewLink.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Raw Drive query (`q`). Overrides the convenience fields." },
        name_contains: { type: "string", description: "Match files whose name contains this text." },
        mime_type: { type: "string", description: "Match a MIME type, e.g. application/pdf or application/vnd.google-apps.folder." },
        in_folder: { type: "string", description: "Restrict to children of this folder id." },
        include_trashed: { type: "boolean", description: "Include trashed files (default false)." },
        page_size: { type: "number", description: "Max results, 1–100 (default 25)." },
        order_by: { type: "string", description: "e.g. modifiedTime desc, name (default modifiedTime desc)." },
      },
    },
    handler: async (args) => {
      let q = optStr(args, "query");
      if (!q) {
        const clauses: string[] = [];
        const nameC = optStr(args, "name_contains");
        const mime = optStr(args, "mime_type");
        const folder = optStr(args, "in_folder");
        if (nameC) clauses.push(`name contains '${nameC.replace(/'/g, "\\'")}'`);
        if (mime) clauses.push(`mimeType='${mime}'`);
        if (folder) clauses.push(`'${folder}' in parents`);
        q = clauses.join(" and ");
      }
      if (!(args.include_trashed === true)) {
        q = q ? `(${q}) and trashed=false` : "trashed=false";
      }
      const pageSize = Math.min(Math.max(Number(args.page_size) || 25, 1), 100);
      const orderBy = optStr(args, "order_by") ?? "modifiedTime desc";
      const url =
        `${API}/files?${SHARED}&pageSize=${pageSize}` +
        `&orderBy=${encodeURIComponent(orderBy)}` +
        `&q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}`;
      return formatResult("drive_search", await restRequest(url, { headers: authHeaders() }));
    },
  },
  {
    name: "drive_get",
    description: "Get a Drive file's metadata by id (name, type, size, parents, link, owners).",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
    },
    handler: async (args) => {
      const id = reqStr(args, "file_id");
      const url = `${API}/files/${encodeURIComponent(id)}?${SHARED}&fields=${encodeURIComponent(FILE_FIELDS)}`;
      return formatResult("drive_get", await restRequest(url, { headers: authHeaders() }));
    },
  },
  {
    name: "drive_read",
    description:
      "Read a file's text content. Google Docs/Sheets/Slides are exported to text/CSV; other text files are downloaded. Binary files return metadata and a note (use the webViewLink to open them). Truncated to max_chars.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        max_chars: { type: "number", description: "Truncate content to this many characters (default 20000)." },
      },
      required: ["file_id"],
    },
    handler: async (args) => {
      const id = reqStr(args, "file_id");
      const maxChars = Math.min(Math.max(Number(args.max_chars) || 20000, 100), 200000);
      const metaUrl = `${API}/files/${encodeURIComponent(id)}?${SHARED}&fields=id,name,mimeType,size,webViewLink`;
      const meta = await restRequest(metaUrl, { headers: authHeaders() });
      if (!meta.ok) return formatResult("drive_read (metadata)", meta);
      const mimeType = (meta.json as { mimeType?: string })?.mimeType ?? "";
      const name = (meta.json as { name?: string })?.name ?? id;

      let contentUrl: string;
      if (mimeType.startsWith("application/vnd.google-apps.")) {
        const exportMime = EXPORT_MIME[mimeType];
        if (!exportMime) {
          return `"${name}" is a Google-native file of type ${mimeType} that has no text export. Open it via its webViewLink:\n${JSON.stringify(meta.json, null, 2)}`;
        }
        contentUrl = `${API}/files/${encodeURIComponent(id)}/export?${SHARED}&mimeType=${encodeURIComponent(exportMime)}`;
      } else {
        contentUrl = `${API}/files/${encodeURIComponent(id)}?${SHARED}&alt=media`;
      }
      const res = await fetch(contentUrl, { headers: authHeaders() });
      if (!res.ok) {
        const errText = await res.text();
        return `drive_read failed for "${name}" (HTTP ${res.status}):\n${errText.slice(0, 2000)}`;
      }
      const ctype = res.headers.get("content-type") ?? "";
      const isTextual = ctype.startsWith("text/") || ctype.includes("json") || ctype.includes("csv") || ctype.includes("xml") || mimeType.startsWith("application/vnd.google-apps.");
      if (!isTextual) {
        return `"${name}" (${mimeType || ctype}) is a binary file — not shown as text. Open it via its webViewLink:\n${JSON.stringify(meta.json, null, 2)}`;
      }
      const body = await res.text();
      const clipped = body.length > maxChars ? body.slice(0, maxChars) + "\n…(truncated)" : body;
      return `# ${name} (${mimeType})\n\n${clipped}`;
    },
  },
  {
    name: "drive_create",
    description:
      "Create a new file. With content + a Google-native mime_type (e.g. application/vnd.google-apps.document) Drive converts the text into a Doc; with a normal mime_type it stores the bytes. Omit content to create an empty file. Returns the new file's metadata.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string", description: "UTF-8 text content (optional)." },
        mime_type: { type: "string", description: "Target MIME type (default text/plain). Use application/vnd.google-apps.document to make a Google Doc from the text." },
        folder_id: { type: "string", description: "Parent folder id (optional)." },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const name = reqStr(args, "name");
      const content = optStr(args, "content");
      const mimeType = optStr(args, "mime_type") ?? "text/plain";
      const folder = optStr(args, "folder_id");
      const metadata: Record<string, unknown> = { name, mimeType };
      if (folder) metadata.parents = [folder];

      // No content → metadata-only create. With content → multipart upload so the
      // bytes and the metadata (incl. conversion target mimeType) go together.
      if (content === undefined) {
        const url = `${API}/files?${SHARED}&fields=${encodeURIComponent(FILE_FIELDS)}`;
        return formatResult(
          "drive_create",
          await restRequest(url, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(metadata),
          }),
        );
      }
      const boundary = "smrtesy-" + Math.random().toString(36).slice(2);
      const sourceMime = mimeType.startsWith("application/vnd.google-apps.") ? "text/plain" : mimeType;
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${sourceMime}\r\n\r\n` +
        `${content}\r\n--${boundary}--`;
      const url = `${UPLOAD}/files?uploadType=multipart&${SHARED}&fields=${encodeURIComponent(FILE_FIELDS)}`;
      return formatResult(
        "drive_create",
        await restRequest(url, {
          method: "POST",
          headers: authHeaders({ "Content-Type": `multipart/related; boundary=${boundary}` }),
          body: multipart,
        }),
      );
    },
  },
  {
    name: "drive_update",
    description:
      "Update an existing file: rename (new_name), replace its content (new_content), and/or move it (add_parents / remove_parents, comma-separated folder ids). Returns the updated metadata.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        new_name: { type: "string" },
        new_content: { type: "string", description: "Replace the file's content with this UTF-8 text." },
        add_parents: { type: "string", description: "Comma-separated folder ids to add (move into)." },
        remove_parents: { type: "string", description: "Comma-separated folder ids to remove." },
      },
      required: ["file_id"],
    },
    handler: async (args) => {
      const id = reqStr(args, "file_id");
      const newName = optStr(args, "new_name");
      const newContent = optStr(args, "new_content");
      const addParents = optStr(args, "add_parents");
      const removeParents = optStr(args, "remove_parents");

      const params = new URLSearchParams({ supportsAllDrives: "true" });
      if (addParents) params.set("addParents", addParents);
      if (removeParents) params.set("removeParents", removeParents);
      params.set("fields", FILE_FIELDS);

      // Content change goes through the upload endpoint; a pure metadata change
      // (rename/move) goes through the files endpoint. When both are asked for,
      // do the media upload first, then the metadata PATCH.
      let last;
      if (newContent !== undefined) {
        const url = `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`;
        last = await restRequest(url, {
          method: "PATCH",
          headers: authHeaders({ "Content-Type": "text/plain" }),
          body: newContent,
        });
        if (!last.ok) return formatResult("drive_update (content)", last);
      }
      if (newName || addParents || removeParents) {
        const url = `${API}/files/${encodeURIComponent(id)}?${params.toString()}`;
        last = await restRequest(url, {
          method: "PATCH",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(newName ? { name: newName } : {}),
        });
      }
      if (!last) throw new Error("Nothing to update — provide new_name, new_content, add_parents, or remove_parents.");
      return formatResult("drive_update", last);
    },
  },
  {
    name: "drive_trash",
    description: "Move a file to Trash (default) or permanently delete it (permanent=true). Trashing is reversible; permanent deletion is not.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        permanent: { type: "boolean", description: "Permanently delete instead of trashing (irreversible)." },
      },
      required: ["file_id"],
    },
    handler: async (args) => {
      const id = reqStr(args, "file_id");
      if (args.permanent === true) {
        const url = `${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`;
        const r = await restRequest(url, { method: "DELETE", headers: authHeaders() });
        return r.ok ? `Permanently deleted ${id}.` : formatResult("drive_trash (delete)", r);
      }
      const url = `${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,trashed`;
      return formatResult(
        "drive_trash",
        await restRequest(url, {
          method: "PATCH",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ trashed: true }),
        }),
      );
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a folder. Optionally nest it under parent_id. Returns the new folder's metadata.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parent_id: { type: "string" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const name = reqStr(args, "name");
      const parent = optStr(args, "parent_id");
      const metadata: Record<string, unknown> = { name, mimeType: "application/vnd.google-apps.folder" };
      if (parent) metadata.parents = [parent];
      const url = `${API}/files?${SHARED}&fields=${encodeURIComponent(FILE_FIELDS)}`;
      return formatResult(
        "drive_create_folder",
        await restRequest(url, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(metadata),
        }),
      );
    },
  },
  {
    name: "drive_share",
    description:
      "Grant access to a file/folder by creating a permission. role: reader | commenter | writer. type: user | group | domain | anyone. For user/group provide email; for domain provide domain. Returns the created permission.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        role: { type: "string", enum: ["reader", "commenter", "writer"] },
        type: { type: "string", enum: ["user", "group", "domain", "anyone"] },
        email: { type: "string", description: "Email for type user/group." },
        domain: { type: "string", description: "Domain for type domain." },
        send_notification: { type: "boolean", description: "Email the grantee (default false)." },
      },
      required: ["file_id", "role", "type"],
    },
    handler: async (args) => {
      const id = reqStr(args, "file_id");
      const role = reqStr(args, "role");
      const type = reqStr(args, "type");
      const perm: Record<string, unknown> = { role, type };
      const email = optStr(args, "email");
      const domain = optStr(args, "domain");
      if (email) perm.emailAddress = email;
      if (domain) perm.domain = domain;
      const notify = args.send_notification === true ? "true" : "false";
      const url = `${API}/files/${encodeURIComponent(id)}/permissions?supportsAllDrives=true&sendNotificationEmail=${notify}`;
      return formatResult(
        "drive_share",
        await restRequest(url, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(perm),
        }),
      );
    },
  },
  {
    name: "drive_request",
    description:
      "Escape hatch: call any Google Drive REST v3 endpoint directly when no specific tool fits. path is appended to https://www.googleapis.com/drive/v3 (e.g. \"/files/ID/comments\"). body is sent as JSON for non-GET methods.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], description: "HTTP method (default GET)." },
        path: { type: "string", description: "Path under /drive/v3, must start with /." },
        query: { type: "string", description: "Raw query string without the leading ? (optional)." },
        body: { type: "object", description: "JSON body for POST/PATCH (optional)." },
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
        `drive_request ${method} ${path}`,
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
  // Should never happen (the runner only registers us when a token exists), but
  // fail loudly on stderr rather than serving tools that will 401 on every call.
  console.error("[mcp:gdrive] SMRTESY_GDRIVE_TOKEN is not set — Drive tools will fail.");
}
runStdioServer({ name: "gdrive", version: "1.0.0" }, tools);
