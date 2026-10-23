#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const fixtureBase = process.env.PJR15_FIXTURE_URL?.replace(/\/$/, "");

async function recordMutating(tool, args) {
  if (!fixtureBase) return;
  try {
    await fetch(`${fixtureBase}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    // loopback fixture only; ignore
  }
}

const server = new McpServer({ name: "job-playwright-stub", version: "0.0.1" });

server.registerTool(
  "browser_navigate",
  {
    description: "Stub navigation (simulates a redirect to the dashboard)",
    inputSchema: { url: z.string() },
    annotations: { destructiveHint: true },
  },
  async () => ({ content: [{ type: "text", text: "### Page\n- Page URL: http://127.0.0.1:4747/" }] }),
);

server.registerTool(
  "browser_click",
  {
    description: "Stub click",
    inputSchema: { element: z.string(), ref: z.string() },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  async (args) => {
    await recordMutating("browser_click", args);
    return { content: [{ type: "text", text: `clicked ${args.element}@${args.ref}` }] };
  },
);

server.registerTool(
  "browser_type",
  {
    description: "Stub type into a field",
    inputSchema: { element: z.string(), ref: z.string(), text: z.string() },
    annotations: { destructiveHint: true },
  },
  async (args) => {
    await recordMutating("browser_type", args);
    return { content: [{ type: "text", text: `typed into ${args.element}@${args.ref}` }] };
  },
);

server.registerTool(
  "browser_snapshot",
  {
    description: "Stub snapshot",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => ({
    content: [{ type: "text", text: "### Snapshot\n- button [ref=e1]" }],
  }),
);

server.registerTool(
  "browser_run_code_unsafe",
  {
    description: "Stub run code",
    inputSchema: {
      filename: z.string().optional(),
      code: z.string().optional(),
    },
    annotations: { destructiveHint: true },
  },
  async (args) => {
    await recordMutating("browser_run_code_unsafe", args);
    return {
      content: [{ type: "text", text: [
        "### Result",
        '{"state":"submitted"}',
        "### Ran Playwright code",
        "```js",
        'await (async (page) => { const x = { a: 1 }; if (x.a) { return { state: "submitted" }; } return { state: "unknown" }; }',
        ")(page);",
        "```",
        "### Page",
        "- Page URL: about:blank",
      ].join("\n") }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
