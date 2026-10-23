#!/usr/bin/env node
//
// Measure a pi session against the assignment's success criteria: turns per
// application (<= 15) and context tokens per application (< 1M).
//
// This is the audit's method, made repeatable:
//   turns          = number of assistant messages
//   context tokens = sum over assistant messages of usage.input + usage.cacheRead
//   peak per turn  = max of that same sum on a single assistant message
//
// Usage:
//   node scripts/measure-session.mjs [path-to-session.jsonl] [--json]
//
// With no path, the newest *.jsonl in the pi session directory is used
// (override the directory with PI_JOBS_SESSION_DIR). With --json, stdout is
// the JSON object only, so it can be pasted verbatim as evidence; warnings
// still go to stderr.
//
// Session files reach 27 MB, so lines are streamed and parsed one at a time —
// never read or JSON.parse a whole file here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// pi keeps a project's sessions under ~/.pi/agent/sessions/--<cwd with "/" as "-">--.
const DEFAULT_SESSION_DIR = path.join(
  os.homedir(),
  ".pi/agent/sessions",
  `--${process.cwd().replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`,
);

const USAGE = `Usage: node scripts/measure-session.mjs [path-to-session.jsonl] [--json]

  path    a pi session JSONL. Defaults to the newest *.jsonl in
          $PI_JOBS_SESSION_DIR (default: ${DEFAULT_SESSION_DIR}).
  --json  print only the JSON object on stdout (warnings stay on stderr).`;

function die(message) {
  process.stderr.write(`measure-session: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let file = null;
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) die(`unknown flag ${arg}\n\n${USAGE}`);
    else if (file === null) file = arg;
    else die(`unexpected extra argument ${arg}\n\n${USAGE}`);
  }
  return { file, json };
}

// Newest by mtime, matching `ls -t` — a session file is rewritten as the
// session grows, so mtime is "most recently used", not just "most recently started".
function newestSessionFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    die(`cannot read session directory ${dir}: ${err.message}`);
  }
  const candidates = entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) die(`no *.jsonl session files in ${dir}`);
  return candidates[0].full;
}

function resolveFile(arg) {
  const target = arg
    ? path.resolve(arg)
    : newestSessionFile(process.env.PI_JOBS_SESSION_DIR || DEFAULT_SESSION_DIR);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    die(`cannot read ${target}: ${err.message}`);
  }
  if (stat.isDirectory()) die(`${target} is a directory, not a session JSONL`);
  return target;
}

function toolCallArgs(item) {
  const args = item.arguments;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === "object" ? args : null;
}

// MCP inner tool names usually carry their server's own prefix
// (job-playwright -> job_playwright_browser_navigate), but the call that names
// the tool often omits arguments.server — only the connect/search calls carry
// it, and some sessions never record it at all. So server names are collected
// across the whole file, seeded with this workspace's own servers, and the
// prefixes are stripped afterwards in normalizeToolCalls. Stripping keeps the
// labels comparable between sessions.
const KNOWN_MCP_SERVERS = ["job-playwright", "playwright"];

function serverPrefixes(servers) {
  return [...servers]
    .map((server) => `${server.replace(/-/g, "_")}_`)
    .sort((a, b) => b.length - a.length); // longest first: job_playwright_ before playwright_
}

function normalizeToolCalls(plainTools, mcpTools, servers) {
  const prefixes = serverPrefixes(servers);
  const merged = new Map();
  const add = (label, count) => merged.set(label, (merged.get(label) || 0) + count);
  for (const [name, count] of plainTools) add(name, count);
  for (const [inner, count] of mcpTools) {
    if (!inner) {
      add("mcp", count); // connect/search/describe calls name no inner tool
      continue;
    }
    const prefix = prefixes.find((candidate) => inner.startsWith(candidate));
    add(`mcp:${prefix ? inner.slice(prefix.length) : inner}`, count);
  }
  return merged;
}

function firstUserText(message) {
  const content = message.content;
  const raw = Array.isArray(content)
    ? content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join(" ")
    : typeof content === "string"
      ? content
      : "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat;
}

async function measure(file) {
  const stats = {
    file,
    provider: null,
    model: null,
    firstUserMessage: "",
    turns: 0,
    totalContextTokens: 0,
    peakTurnContextTokens: 0,
    outputTokens: 0,
    totalToolCalls: 0,
    greenhouseToolCalls: 0,
    toolCalls: new Map(),
    cacheReadTotal: 0,
    skippedLines: 0,
  };
  const plainTools = new Map();
  const mcpTools = new Map();
  const servers = new Set(KNOWN_MCP_SERVERS);
  let lastModelChange = null;
  let firstAssistant = null;
  let sawFirstUser = false;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.skippedLines++;
      continue;
    }

    if (entry.type === "model_change") {
      lastModelChange = { provider: entry.provider, model: entry.modelId };
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    const message = entry.message;
    if (message.role === "user") {
      if (!sawFirstUser) {
        sawFirstUser = true;
        stats.firstUserMessage = firstUserText(message);
      }
      continue;
    }
    if (message.role !== "assistant") continue;

    stats.turns++;
    if (!firstAssistant) {
      firstAssistant = { provider: message.provider, model: message.model };
    }

    const usage = message.usage || {};
    const input = Number(usage.input) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const turnContext = input + cacheRead;
    stats.totalContextTokens += turnContext;
    stats.cacheReadTotal += cacheRead;
    stats.outputTokens += Number(usage.output) || 0;
    if (turnContext > stats.peakTurnContextTokens) {
      stats.peakTurnContextTokens = turnContext;
    }

    if (!Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (!item || item.type !== "toolCall") continue;
      stats.totalToolCalls++;
      if (item.name === "mcp") {
        const args = toolCallArgs(item);
        if (args && typeof args.server === "string" && args.server) servers.add(args.server);
        const inner = args && typeof args.tool === "string" ? args.tool : "";
        mcpTools.set(inner, (mcpTools.get(inner) || 0) + 1);
      } else {
        const name = item.name || "(unnamed)";
        plainTools.set(name, (plainTools.get(name) || 0) + 1);
      }
    }
  }

  stats.toolCalls = normalizeToolCalls(plainTools, mcpTools, servers);
  // AC 2 rollback proof: a switch-off run must show zero of these.
  for (const [label, count] of stats.toolCalls) {
    if (/(^|:)greenhouse_/.test(label)) stats.greenhouseToolCalls += count;
  }

  const source = lastModelChange || firstAssistant || {};
  stats.provider = source.provider || "unknown";
  stats.model = source.model || "unknown";
  return stats;
}

function buildWarnings(stats) {
  const warnings = [];
  if (stats.provider.startsWith("cursor/") || stats.provider === "cursor") {
    warnings.push(
      `provider "${stats.provider}/${stats.model}" reports cacheRead: 0 — its context totals are NOT comparable to the audit baseline (Decision 5). Re-run on an opencode-go/* or synthetic/* session to compare.`,
    );
  }
  if (stats.turns === 0) {
    warnings.push(
      "no assistant turns found — this file is empty or is not a pi session JSONL. A zero here is not a result.",
    );
  }
  if (stats.turns > 0 && stats.cacheReadTotal === 0) {
    warnings.push(
      "every assistant turn reported cacheRead: 0 — total context tokens are undercounted and not comparable to the audit baseline.",
    );
  }
  if (stats.skippedLines > 0) {
    warnings.push(`${stats.skippedLines} line(s) were not valid JSON and were skipped.`);
  }
  return warnings;
}

function topTools(stats, limit = 10) {
  return [...stats.toolCalls.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function printText(stats, warnings, tools) {
  const n = (value) => value.toLocaleString("en-US");
  const lines = [
    `file: ${stats.file}`,
    `provider/model: ${stats.provider}/${stats.model}`,
    `first user message: ${stats.firstUserMessage || "(none)"}`,
    `turns (assistant messages): ${n(stats.turns)}`,
    `total context tokens: ${n(stats.totalContextTokens)}`,
    `peak per-turn context: ${n(stats.peakTurnContextTokens)}`,
    `output tokens: ${n(stats.outputTokens)}`,
    `tool calls: ${n(stats.totalToolCalls)}`,
    `greenhouse_* tool calls: ${n(stats.greenhouseToolCalls)}`,
  ];
  for (const warning of warnings) lines.push(`WARNING: ${warning}`);
  if (warnings.length === 0) lines.push("warnings: none");

  if (tools.length > 0) {
    const width = Math.max(...tools.map((tool) => tool.name.length));
    lines.push("", `top tool calls (${tools.length} of ${stats.toolCalls.size}):`);
    for (const tool of tools) {
      lines.push(`  ${tool.name.padEnd(width)}  ${String(tool.count).padStart(5)}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

const { file: fileArg, json } = parseArgs(process.argv.slice(2));
const file = resolveFile(fileArg);
const stats = await measure(file);
const warnings = buildWarnings(stats);
const tools = topTools(stats);

for (const warning of warnings) process.stderr.write(`WARNING: ${warning}\n`);

if (json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        file: stats.file,
        provider: stats.provider,
        model: stats.model,
        firstUserMessage: stats.firstUserMessage,
        turns: stats.turns,
        totalContextTokens: stats.totalContextTokens,
        peakTurnContextTokens: stats.peakTurnContextTokens,
        outputTokens: stats.outputTokens,
        totalToolCalls: stats.totalToolCalls,
        greenhouseToolCalls: stats.greenhouseToolCalls,
        topToolCalls: tools,
        skippedLines: stats.skippedLines,
        warnings,
      },
      null,
      2,
    )}\n`,
  );
} else {
  printText(stats, warnings, tools);
}
