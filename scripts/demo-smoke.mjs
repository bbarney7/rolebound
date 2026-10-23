#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch, freePort, stopChild, assertPortReleased } from "./smoke-support.mjs";
import { DEMO_CONNECTION_ID } from "./demo-constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = await freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-demo-smoke-home-"));

function waitFor(url, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            if (predicate(res, body)) return resolve({ res, body: JSON.parse(body) });
          } catch {}
          if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
          setTimeout(tick, 150);
        });
      }).on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (!fs.existsSync(path.join(root, "ui", "dist", "index.html"))) {
  const build = spawn(process.execPath, ["scripts/pi-jobs.mjs", "build"], { cwd: root, stdio: "inherit" });
  assert.equal(await new Promise((resolve) => build.on("exit", resolve)), 0);
}

const running = launch(process.execPath, ["scripts/pi-jobs.mjs", "demo", "--port", String(port)], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: home, NODE_ENV: process.env.NODE_ENV },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const { body: health } = await waitFor(healthUrl, (res, body) => res.statusCode === 200 && body.includes('"demo":true'));
  assert.equal(health.demo, true);
  const demoRoot = health.root;
  assert.notEqual(demoRoot, root);
  assert.match(health.demoLabel, /demo/i);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/connections/fixture/test`, { method: "POST" })).status, 409);
  assert.equal((await fetch(`${base}/api/connections/${DEMO_CONNECTION_ID}/models`)).status, 409);
  assert.equal((await fetch(`${base}/api/settings/captcha/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 409);

  const readiness = await (await fetch(`${base}/api/readiness`)).json();
  assert.equal(readiness.applyReady, true, "populated demo seed must reach applyReady");
  assert.equal(readiness.steps.find((step) => step.id === "readiness")?.complete, true);
  assert.match(DEMO_CONNECTION_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const session = await (await fetch(`${base}/api/session`)).json();
  const csrf = session.csrfToken;
  assert.ok(typeof csrf === "string" && csrf.length > 10);

  const start = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pi-jobs-csrf": csrf },
    body: JSON.stringify({ kind: "status" }),
  });
  if (start.status !== 201) assert.fail(`expected 201, got ${start.status}: ${await start.text()}`);
  const run = await start.json();

  for (let i = 0; i < 40; i++) {
    const current = await (await fetch(`${base}/api/runs/current`)).json();
    if (current.events.some((entry) => entry.type === "notify" && /demo synthetic runner loaded/i.test(String(entry.message)))) break;
    await sleep(100);
  }
  const afterStart = await (await fetch(`${base}/api/runs/current`)).json();
  assert.ok(afterStart.events.some((entry) => entry.type === "notify" && /demo synthetic runner loaded/i.test(String(entry.message))));

  for (let i = 0; i < 40; i++) {
    const current = await (await fetch(`${base}/api/runs/current`)).json();
    if (current.run?.status === "waiting" || current.run?.status === "running") break;
    await sleep(100);
  }
  const ready = await (await fetch(`${base}/api/runs/current`)).json();
  assert.match(String(ready.run?.status), /waiting|running/);

  const reply = await fetch(`${base}/api/runs/${run.runId}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pi-jobs-csrf": csrf },
    body: JSON.stringify({ message: "/status" }),
  });
  if (reply.status !== 200) assert.fail(`expected 200, got ${reply.status}: ${await reply.text()}`);

  const finish = await fetch(`${base}/api/runs/${run.runId}/finish`, { method: "POST", headers: { "x-pi-jobs-csrf": csrf } });
  if (finish.status !== 200) assert.fail(`expected 200, got ${finish.status}: ${await finish.text()}`);

  await stopChild(running);
  await assertPortReleased(port);
  assert.equal(fs.existsSync(demoRoot), false, "demo data removed only after shutdown");
  const emptyPort = await freePort();
  const empty = launch(process.execPath, ["scripts/pi-jobs.mjs", "demo", "--empty", "--port", String(emptyPort)], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV } });
  try {
    const { body: emptyHealth } = await waitFor(`http://127.0.0.1:${emptyPort}/api/health`, (res, body) => res.statusCode === 200 && body.includes('"demo":true'));
    await stopChild(empty);
    await assertPortReleased(emptyPort);
    assert.equal(fs.existsSync(emptyHealth.root), false);
  } finally { await stopChild(empty, "SIGTERM", false); }
  const terminalPort = await freePort();
  const terminal = launch("npm", ["run", "demo", "--", "--port", String(terminalPort)], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV }, detached: true });
  try {
    const base = `http://127.0.0.1:${terminalPort}`;
    const { body: terminalHealth } = await waitFor(`${base}/api/health`, (res, text) => res.statusCode === 200 && text.includes('"demo":true'));
    const session = await (await fetch(`${base}/api/session`)).json();
    const created = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-pi-jobs-csrf": session.csrfToken }, body: JSON.stringify({ kind: "status" }) });
    assert.equal(created.status, 201);
    const { body: active } = await waitFor(`${base}/api/runs/current`, (res, text) => res.statusCode === 200 && text.includes("demo synthetic runner loaded"));
    const pid = active.run.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);
    await stopChild(terminal, "SIGINT");
    await assertPortReleased(terminalPort);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(fs.existsSync(terminalHealth.root), false);
  } finally { await stopChild(terminal, "SIGTERM", false); }
  console.log("demo smoke passed: seeded applyReady workspace, external routes blocked, fake run reply/finish");
} finally {
  await stopChild(running);
  await assertPortReleased(port);
  fs.rmSync(home, { recursive: true, force: true });
}
