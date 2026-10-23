#!/usr/bin/env node
/**
 * Production demo RPC runner — synthetic pi protocol only.
 * No network, no real pi, no employer submissions. Spawned by demoRuntime.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { commitDemoApplication, isSafeDemoSlug, persistDemoScores } from "./demoArtifacts.mjs";

const DEMO_BANNER =
  "demo synthetic runner loaded — fictional workflows only; no external calls or real submissions";

if (process.env.NO_EXTERNAL_CALLS !== "1" && process.env.PI_JOBS_DEMO !== "1") {
  process.stderr.write("[demoFakePi] refused: demo env sentinels missing\n");
  process.exit(2);
}

let uid = 0;
const pendingDialogs = new Map();
let chain = Promise.resolve();

process.on("SIGTERM", () => process.exit(0));

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notify(message, notifyType = "info") {
  write({
    type: "extension_ui_request",
    id: `n${++uid}`,
    method: "notify",
    message,
    notifyType,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dialog(spec) {
  const id = `d${++uid}`;
  return new Promise((resolve) => {
    pendingDialogs.set(id, resolve);
    write({ type: "extension_ui_request", id, ...spec });
  });
}

function enqueue(fn) {
  chain = chain.then(fn).catch(() => {});
}

function workspaceRoot() {
  return process.cwd();
}

function parseApplySlug(message) {
  const match = message.match(/Apply to the next queued job:\s*(\S+)/);
  const slug = match?.[1] ?? "demo-queued-role";
  return isSafeDemoSlug(slug) ? slug : null;
}

function writeDemoReceipt(slug) {
  if (!slug) {
    notify("Demo apply refused — invalid slug", "warning");
    return null;
  }
  try {
    const result = commitDemoApplication(workspaceRoot(), slug);
    notify(`Demo receipt written: ${result.screenshotRel} and ${result.appliedPath} (fictional — not a real submission)`);
    return result;
  } catch (error) {
    notify(`Demo apply failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return null;
  }
}

function writeGatherDiscovery() {
  const root = workspaceRoot();
  const dir = path.join(root, "jobs", "discovered");
  fs.mkdirSync(dir, { recursive: true });
  const slug = "demo-gathered-role";
  const file = path.join(dir, `${slug}.md`);
  if (fs.existsSync(file)) {
    notify(`Demo gather replay: jobs/discovered/${slug}.md already present (synthetic)`);
    return slug;
  }
  fs.writeFileSync(
    file,
    `---\ndemo: true\nurl: https://example.invalid/jobs/${slug}\ncompany: Demo Company\ntitle: Demo Gathered Role\nlocation: Remote\nsource: greenhouse\ndiscovered_at: ${new Date().toISOString()}\n---\nFictional posting created by the demo gather workflow.\n`,
  );
  notify(`Demo gather wrote jobs/discovered/${slug}.md (fictional — no ATS contacted)`);
  return slug;
}

async function assistantTurn(text, tool) {
  write({ type: "agent_start" });
  write({ type: "message_start", message: {} });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
  });
  if (tool) {
    const toolCallId = `call_${++uid}`;
    write({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: toolCallId,
        toolName: tool.name,
      },
    });
    write({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: toolCallId, toolName: tool.name, args: tool.args },
      },
    });
    write({ type: "tool_execution_start", toolCallId, toolName: tool.name, args: tool.args });
    write({
      type: "tool_execution_end",
      toolCallId,
      toolName: tool.name,
      result: { content: [{ type: "text", text: tool.result }], ...(tool.details ? { details: tool.details } : {}) },
      isError: false,
    });
  }
  write({ type: "message_end", message: {} });
  write({ type: "agent_end", messages: [], willRetry: false });
  write({ type: "agent_settled" });
}

async function gatherTurn() {
  const slug = writeGatherDiscovery();
  await assistantTurn(
    `[DEMO] Simulated /gather against fictional targets — staged ${slug} locally. No employer APIs were called.`,
    { name: "browser_navigate", args: { url: "https://example.invalid/careers/demo" }, result: "demo gather complete (synthetic)" },
  );
}

async function scoreTurn() {
  const updated = persistDemoScores(workspaceRoot());
  notify(`Demo /score-discovered: wrote synthetic llm_score to ${updated} discovered job(s)`);
  await assistantTurn(
    `[DEMO] Simulated scoring for ${updated} discovered job(s). Scores are synthetic labels for UI review — not from a live model.`,
  );
}

async function applyTurn(message) {
  const slug = parseApplySlug(message);
  if (!slug) {
    notify("Demo apply refused — could not resolve a safe queue slug", "warning");
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "agent_start" });
  write({ type: "message_start", message: {} });
  const intro =
    `[DEMO] Preparing a fictional application for ${slug}. The browser step uses example.invalid only; nothing is submitted to a real ATS.`;
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: intro } });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: intro } });

  const toolCallId = `call_${++uid}`;
  const args = { url: `https://example.invalid/jobs/${slug}` };
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: toolCallId, toolName: "browser_navigate" },
  });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { id: toolCallId, toolName: "browser_navigate", args },
    },
  });
  write({ type: "tool_execution_start", toolCallId, toolName: "browser_navigate", args });
  write({
    type: "tool_execution_end",
    toolCallId,
    toolName: "browser_navigate",
    result: { content: [{ type: "text", text: "demo form loaded (synthetic)" }] },
    isError: false,
  });

  const answer = await dialog({
    method: "input",
    title: "Demo verification code",
    message:
      "Enter any code. This fictional flow mimics an emailed security code; no employer is contacted.",
  });
  if (answer.cancelled || !String(answer.value ?? "").trim()) {
    notify("Demo apply paused — verification code not entered");
    write({ type: "message_end", message: {} });
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }
  const receipt = writeDemoReceipt(slug);
  if (!receipt) {
    write({ type: "message_end", message: {} });
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }
  const done = `[DEMO] Stored synthetic receipt for ${slug}. This is not a real job submission.`;
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 2 } });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: done } });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 2, content: done } });
  write({ type: "message_end", message: {} });
  write({ type: "agent_end", messages: [], willRetry: false });
  write({ type: "agent_settled" });
}

const DEMO_JOBS = [
  { slug: "demo-northwind-staff-eng", company: "Northwind Labs", title: "Staff Software Engineer", location: "Remote (US)", url: "https://example.invalid/northwind/staff-eng", score: 92 },
  { slug: "demo-tailspin-platform", company: "Tailspin Systems", title: "Senior Platform Engineer", location: "Denver, CO", url: "https://example.invalid/tailspin/platform", score: 86 },
  { slug: "demo-fabrikam-infra", company: "Fabrikam", title: "Infrastructure Engineer", location: "Hybrid, Austin, TX", url: "https://example.invalid/fabrikam/infra", score: 78 },
];

/** Synthetic chat turns that exercise every transcript card without a model or network. */
async function chatTurn(message) {
  const lower = message.toLowerCase();
  if (lower.includes("attached file:") || lower.includes("resume")) {
    const attached = /Attached file: (\S+)/.exec(message)?.[1] ?? "uploads/demo-resume.pdf";
    await assistantTurn("[DEMO] Reading your resume now.", {
      name: "resume_extract_text",
      args: { path: attached },
      result: "Extracted 412 words (synthetic)",
      details: { card: "run-progress", path: attached, text: "Synthetic resume text. ".repeat(80) },
    });
    await assistantTurn(
      "[DEMO] I filled in your **work history** from that resume. Two things I can't guess:\n\n- Which cities would you work in?\n- What's your salary floor?",
      {
        name: "profile_update_section",
        args: { section: "Work history" },
        result: "Updated ## Work history",
        details: {
          card: "profile-diff",
          section: "Work history",
          before: "- (empty)",
          after: "- **Northwind Labs**, Senior Engineer, 2021 to now\n- **Contoso**, Software Engineer, 2017 to 2021",
        },
      },
    );
    return;
  }
  if (lower.includes("find") || lower.includes("roles") || lower.includes("jobs")) {
    await assistantTurn("[DEMO] I checked your companies to watch. Three fictional roles fit well:", {
      name: "queue_add_url",
      args: { count: DEMO_JOBS.length },
      result: `Found ${DEMO_JOBS.length} roles (synthetic)`,
      details: { card: "job-list", jobs: DEMO_JOBS },
    });
    return;
  }
  await assistantTurn(
    "[DEMO] I can **import your resume**, find roles at companies you name, and fill out applications in a browser you can watch. Try \"find new roles\" or drop a resume here.",
  );
}

async function runTurn(message) {
  if (process.env.PI_JOBS_RUN_KIND === "chat") return chatTurn(message);
  if (message.includes("/gather")) return gatherTurn();
  if (message.includes("/score-discovered")) return scoreTurn();
  if (message.includes("Apply to the next queued job")) return applyTurn(message);
  await assistantTurn(`[DEMO] Unrecognized supervised prompt in demo mode: ${message.slice(0, 120)}`);
}

function handle(command) {
  switch (command.type) {
    case "prompt": {
      const message = String(command.message ?? "");
      const response = { type: "response", command: "prompt", success: true };
      if (command.id) response.id = command.id;
      write(response);
      if (message.startsWith("/status") || message.startsWith("/noop")) return;
      enqueue(() => runTurn(message));
      return;
    }
    case "abort":
      write({ type: "response", command: "abort", success: true });
      write({ type: "agent_settled" });
      return;
    case "extension_ui_response": {
      const resolve = pendingDialogs.get(command.id);
      if (!resolve) return;
      pendingDialogs.delete(command.id);
      resolve(command);
      return;
    }
    default:
      return;
  }
}

notify(DEMO_BANNER);

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const record = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (record.length > 0) {
      try {
        handle(JSON.parse(record));
      } catch {
        // ignore malformed input
      }
    }
    index = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  setImmediate(() => {
    if (process.stdout.writableLength === 0) process.exit(0);
    process.stdout.once("drain", () => process.exit(0));
  });
});
