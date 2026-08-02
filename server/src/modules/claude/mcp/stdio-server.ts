/**
 * A tiny, dependency-free MCP server over stdio — the shared engine behind the
 * in-app Claude connectors (Google Drive, Canva).
 *
 * WHY hand-rolled instead of `@modelcontextprotocol/sdk`: the SDK is ESM-first
 * and exposes its entry points only through an `exports` map. This server
 * package compiles with `moduleResolution: node` (node10), which does NOT read
 * `exports` maps, so a subpath import like `@modelcontextprotocol/sdk/server/
 * mcp.js` fails to type-check even though it resolves at runtime. Rather than
 * change the whole project's resolution mode for two small files, we implement
 * the exact slice of MCP a tool-only server needs. It is ~130 lines of stable
 * protocol glue — the same class of protocol-critical, hand-verified code as
 * the Supabase cookie serialization in app-access.ts.
 *
 * WIRE FORMAT — verified against the SDK's own transport
 * (`@modelcontextprotocol/sdk/dist/cjs/shared/stdio.js`, 2026-08): newline-
 * delimited JSON-RPC 2.0. Each message is `JSON.stringify(msg) + "\n"`; the
 * reader splits on `\n` and strips a trailing `\r`. Messages therefore MUST NOT
 * contain embedded newlines (JSON.stringify never emits any) and stdout is the
 * protocol channel — ALL logging goes to stderr, or the client's parser breaks.
 */

import { StringDecoder } from "node:string_decoder";

/** JSON Schema object describing a tool's arguments (draft-07 shape). */
export type JsonSchema = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object (type: "object", properties, required). */
  inputSchema: JsonSchema;
  /** Runs the tool. Return human/agent-readable text. Throw to signal an error. */
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

// Protocol versions this server understands. We echo the client's requested
// version when it is one we know, otherwise fall back to a widely-supported one
// — the same negotiation the SDK does. (SUPPORTED list verified from the SDK's
// types.js, 2026-08.)
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/**
 * Start the server: read JSON-RPC messages from stdin, dispatch tool calls,
 * write responses to stdout. Never returns (runs until stdin closes).
 */
export function runStdioServer(
  info: { name: string; version: string },
  tools: McpTool[],
): void {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const log = (...a: unknown[]) => console.error(`[mcp:${info.name}]`, ...a);

  const write = (msg: JsonRpcMessage) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
  const reply = (id: number | string, result: unknown) =>
    write({ jsonrpc: "2.0", id, result });
  const replyError = (id: number | string, code: number, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const handleCall = async (id: number | string, params: Record<string, unknown>) => {
    const name = typeof params?.name === "string" ? params.name : "";
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const tool = byName.get(name);
    // Unknown tool → return an isError result (not a protocol error) so the model
    // sees a readable message and can pick a real tool instead of the turn dying.
    if (!tool) {
      reply(id, {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
      return;
    }
    try {
      const text = await tool.handler(args);
      reply(id, { content: [{ type: "text", text: String(text) }], isError: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reply(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    }
  };

  const dispatch = async (msg: JsonRpcMessage) => {
    const { id, method, params } = msg;
    // Notifications (no id) never get a response.
    const isRequest = id !== undefined && id !== null;

    switch (method) {
      case "initialize": {
        if (!isRequest) return;
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : FALLBACK_PROTOCOL_VERSION;
        reply(id as number | string, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: info.name, version: info.version },
        });
        return;
      }
      case "tools/list": {
        if (!isRequest) return;
        reply(id as number | string, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      }
      case "tools/call": {
        if (!isRequest) return;
        await handleCall(id as number | string, params ?? {});
        return;
      }
      case "ping": {
        if (isRequest) reply(id as number | string, {});
        return;
      }
      default: {
        // notifications/initialized, notifications/cancelled, etc. → ignore.
        if (method?.startsWith("notifications/")) return;
        if (isRequest) replyError(id as number | string, -32601, `Method not found: ${method}`);
      }
    }
  };

  // Buffer stdin and cut it into newline-delimited JSON messages. A partial
  // trailing line is kept until its newline arrives. A StringDecoder (not
  // chunk.toString) is REQUIRED: a large argument — e.g. Hebrew `content` for
  // drive_create/drive_update — fragments across pipe chunks, and decoding each
  // chunk independently would emit U+FFFD for any multibyte character split on a
  // chunk boundary, corrupting the JSON. StringDecoder holds incomplete UTF-8
  // sequences across writes.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch (e) {
        log("bad JSON on stdin:", e instanceof Error ? e.message : e);
        continue;
      }
      // Dispatch is async; errors inside must never crash the read loop.
      void dispatch(parsed).catch((e) => log("dispatch failed:", e instanceof Error ? e.message : e));
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  // The client owns our lifecycle; if it goes away, so do we.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  log(`ready (${tools.length} tools)`);
}
