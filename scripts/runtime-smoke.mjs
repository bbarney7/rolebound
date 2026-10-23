#!/usr/bin/env node
/* Reproducible, offline runtime gate. All model/browser traffic is local. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { close as closeModel, createScriptedModelServer, listen as listenModel } from "./fixtures/scripted-model.mjs";
import { prepareTempAppDir } from "./fixtures/app-dir.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-runtime-") );
const home = path.join(temp, "home");
const app = path.join(temp, "app");
const agentDir = path.join(app, ".pi-jobs", "pi-agent");
await fs.mkdir(path.join(app, ".pi"), { recursive: true });
await fs.mkdir(home, { recursive: true });
await fs.cp(path.join(root, ".pi", "extensions"), path.join(app, ".pi", "extensions"), { recursive: true });
// The extensions share policy and config modules with the dashboard (`ui/shared`), as in a clone.
await fs.cp(path.join(root, "ui", "shared"), path.join(app, "ui", "shared"), { recursive: true });
await fs.mkdir(path.join(app, "screenshots"), { recursive: true });
const smokeMcp = JSON.parse(await fs.readFile(path.join(root, ".pi", "mcp.json"), "utf8"));
smokeMcp.mcpServers["job-playwright"] = {
  ...smokeMcp.mcpServers["job-playwright"],
  command: process.execPath,
  args: [path.join(root, "scripts/fixtures/stub-browser-mcp.mjs")],
};
await fs.writeFile(path.join(app, ".pi", "mcp.json"), `${JSON.stringify(smokeMcp, null, 2)}\n`);
await fs.mkdir(agentDir, { recursive: true });
await fs.copyFile(path.join(app, ".pi", "mcp.json"), path.join(agentDir, "mcp.json"));
// Extensions always run inside a clone with its node_modules (they share
// proper-lockfile with the server), so the copied app resolves them the same way.
await fs.symlink(path.join(root, "node_modules"), path.join(app, "node_modules"), "dir");

function onceServer(handler) { return new Promise((resolve, reject) => { const s = http.createServer(handler); s.once("error", reject); s.listen(0, "127.0.0.1", () => resolve(s)); }); }
function closeServer(s) { return new Promise(resolve => s.close(() => resolve())); }
async function piSmoke() {
  const { RpcClient, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const trustArgs = ["--mode", "rpc", "--offline", "--approve", "--no-session"];
  const rpc = new RpcClient({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd: app, env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, args: trustArgs });
  try {
    await rpc.start();
    const commands = new Set((await rpc.getCommands()).map(x => x.name));
    for (const name of ["apply-next", "gather", "score-discovered", "status", "targets", "tracker"]) assert(commands.has(name), `missing extension command: ${name}`);
    await assertPiBrowserMcpTools(trustArgs);
    await assertCursorPackageKeepsJobTools(trustArgs);
  } finally { await rpc.stop(); }
  const seen = [];
  const server = await onceServer((req, res) => { let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { seen.push({ auth: req.headers.authorization, body }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); }); });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const model = id => ({ id, name: id, api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 100, baseUrl });
    runtime.registerProvider("app-openai-a", { name: "A", baseUrl, api: "openai-completions", apiKey: "key-a", models: [model("m-a")] });
    runtime.registerProvider("app-openai-b", { name: "B", baseUrl, api: "openai-completions", apiKey: "key-b", models: [model("m-b")] });
    assert(runtime.getModel("app-openai-a", "m-a")); assert(runtime.getModel("app-openai-b", "m-b"));
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "local smoke" }] }] };
    await runtime.complete(runtime.getModel("app-openai-a", "m-a"), context); await runtime.complete(runtime.getModel("app-openai-b", "m-b"), context);
    assert.deepEqual(seen.map(x => x.auth), ["Bearer key-a", "Bearer key-b"]);
  } finally { await closeServer(server); }
}
async function assertCursorPackageKeepsJobTools(trustArgs) {
  const toolsOut = path.join(temp, "pi-tools-cursor.json");
  const dumpExt = path.join(root, "scripts/fixtures/runtime-smoke-tools-dump.ts");
  const model = createScriptedModelServer({ steps: [{ text: "ok" }] });
  await listenModel(model);
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const cursorPkg = path.join(root, "node_modules/pi-cursor-sdk");
  await fs.writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [cursorPkg] })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "auth.json"), `${JSON.stringify({ "runtime-smoke": { type: "api_key", key: "smoke-key" } })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "models.json"), `${JSON.stringify({ providers: { "runtime-smoke": { baseUrl, api: "openai-completions", models: [{ id: "scripted", name: "scripted", api: "openai-completions", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }] } } })}\n`);
  const rpc = new (await import("@earendil-works/pi-coding-agent")).RpcClient({
    cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    cwd: app,
    provider: "runtime-smoke",
    model: "scripted",
    env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", RUNTIME_SMOKE_TOOLS_OUT: toolsOut },
    args: [...trustArgs, "-e", dumpExt],
  });
  try {
    await rpc.start();
    await rpc.prompt("ping");
    await rpc.waitForIdle(45_000);
  } finally {
    await rpc.stop();
    await closeModel(model);
  }
  const names = JSON.parse(await fs.readFile(toolsOut, "utf8"));
  for (const tool of ["score_discovered", "score_job", "gather_all", "promote_to_queue"]) {
    assert(names.includes(tool), `missing job tool with cursor package: ${tool}`);
  }
  assert(names.some((name) => name.startsWith("mcp__job_playwright__browser_")), "missing job-playwright tools with cursor package");
}

async function assertPiBrowserMcpTools(trustArgs) {
  const toolsOut = path.join(temp, "pi-tools.json");
  const dumpExt = path.join(root, "scripts/fixtures/runtime-smoke-tools-dump.ts");
  // The prompt only makes pi settle so the dump runs. It must go to a loopback model:
  // RpcClient merges process.env, so an unpinned provider would pick up a real API key.
  const model = createScriptedModelServer({ steps: [{ text: "ok" }] });
  await listenModel(model);
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  await fs.writeFile(path.join(agentDir, "auth.json"), `${JSON.stringify({ "runtime-smoke": { type: "api_key", key: "smoke-key" } })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "models.json"), `${JSON.stringify({ providers: { "runtime-smoke": { baseUrl, api: "openai-completions", models: [{ id: "scripted", name: "scripted", api: "openai-completions", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }] } } })}\n`);
  const rpc = new (await import("@earendil-works/pi-coding-agent")).RpcClient({
    cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    cwd: app,
    provider: "runtime-smoke",
    model: "scripted",
    env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", RUNTIME_SMOKE_TOOLS_OUT: toolsOut },
    args: [...trustArgs, "-e", dumpExt],
  });
  try {
    await rpc.start();
    await rpc.prompt("ping");
    await rpc.waitForIdle(45_000);
  } finally {
    await rpc.stop();
    await closeModel(model);
  }
  const names = JSON.parse(await fs.readFile(toolsOut, "utf8"));
  const browser = names.filter((name) => name.startsWith("mcp__job_playwright__browser_"));
  assert(browser.length >= 3, `expected mcp__job_playwright__browser_* tools, got: ${browser.join(", ")}`);
  for (const tool of ["mcp__job_playwright__browser_run_code_unsafe", "mcp__job_playwright__browser_snapshot", "mcp__job_playwright__browser_click"]) {
    assert(names.includes(tool), `missing pi MCP tool: ${tool}`);
  }
}

async function mcpSmoke() {
  const filename = `.runtime-smoke-${process.pid}.mjs`;
  await fs.writeFile(path.join(root, filename), "async (page) => ({ url: page.url() })\n", { mode: 0o600 });
  // Own Chrome in this process so MCP escalation cannot orphan its detached group.
  const { chromium } = createRequire(path.join(root, "node_modules/@playwright/mcp/cli.js"))("playwright");
  const browser = await chromium.launchServer({ channel: "chrome", headless: true, host: "127.0.0.1", timeout: 45_000,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const browserClosed = new Promise(resolve => browser.process().once("close", (code, signal) => resolve({ code, signal })));
  try { await mcpSession(filename, browser.wsEndpoint()); }
  finally {
    try {
      await within(browser.close(), 5000, "Chrome shutdown timed out");
      const outcome = await within(browserClosed, 2000, "Chrome did not reap");
      assert.equal(outcome.code, 0, `Chrome cleanup failed: ${JSON.stringify(outcome)}`);
    } catch (error) {
      await within(browser.kill(), 2000, "Chrome forced cleanup timed out");
      await within(browserClosed, 2000, "Chrome did not reap after forced cleanup");
      throw error;
    }
  }
}
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function mcpSession(filename, endpoint) {
  const child = spawn(process.execPath, [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--endpoint", endpoint], { cwd: root, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let timer;
  let phase = "initialize";
  let buffer = "";
  let settled = false;
  const wait = new Promise((resolve, reject) => {
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const deadline = (name, ms) => {
      phase = name;
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`MCP ${phase} timed out after ${ms}ms`)), ms);
    };
    const send = message => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (settled) continue;
        try {
          if (message.error) throw new Error(`MCP ${phase} returned a protocol error`);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            deadline("tool listing", 15_000);
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (message.id === 2) {
            const names = new Set(message.result.tools.map(tool => tool.name));
            for (const name of ["browser_run_code_unsafe", "browser_navigate", "browser_snapshot", "browser_tabs", "browser_evaluate", "browser_take_screenshot", "browser_wait_for", "browser_close"]) assert(names.has(name), `missing MCP tool: ${name}`);
            // A cold hosted Chrome launch gets its own bounded budget.
            deadline("browser filename execution", 45_000);
            send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_run_code_unsafe", arguments: { filename } } });
          } else if (message.id === 3) {
            assert.equal(message.result.isError, undefined);
            assert.match(message.result.content?.[0]?.text ?? "", /about:blank/);
            deadline("browser close", 15_000);
            send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_close", arguments: {} } });
          } else if (message.id === 4) {
            assert.equal(message.result.isError, undefined);
            finish();
          }
        } catch (error) { finish(error); }
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", finish);
    child.on("error", finish);
    child.on("exit", (code, signal) => finish(new Error(`MCP exited during ${phase}: code=${code}, signal=${signal}`)));
    deadline("initialize", 15_000);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1" } } });
  });
  try { await wait; }
  finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    const waitForClose = async ms => {
      let cleanupTimer;
      try {
        return await Promise.race([closed, new Promise(resolve => {
          cleanupTimer = setTimeout(() => resolve(null), ms);
        })]);
      } finally { clearTimeout(cleanupTimer); }
    };
    const outcome = await waitForClose(5000);
    if (!outcome) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) { if (error.code !== "ESRCH") throw error; }
      if (!await waitForClose(2000)) throw new Error("MCP child did not reap after SIGKILL");
      throw new Error("MCP shutdown required forced cleanup");
    }
    assert(outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"),
      `MCP cleanup failed: code=${outcome.code}, signal=${outcome.signal}`);
  }
}
try { await piSmoke(); await mcpSmoke(); console.log("runtime smoke passed: pi RPC/extensions, provider aliases, MCP tools/filename execution"); } finally { await fs.rm(temp, { recursive: true, force: true }); await fs.rm(path.join(root, `.runtime-smoke-${process.pid}.mjs`), { force: true }); }
