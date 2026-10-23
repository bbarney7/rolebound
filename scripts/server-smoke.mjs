#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, freePort, waitFor, stopChild, assertPortReleased } from "./smoke-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rolebound-smoke-"));
const env = { ...process.env, PI_JOBS_ROOT: root, PI_CODING_AGENT_DIR: path.join(runtime, "pi-agent") };
fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
try {
  if (!fs.existsSync(path.join(root, "ui/dist/index.html"))) {
    const build = launch(process.execPath, ["scripts/pi-jobs.mjs", "build"], { cwd: root, env });
    assert.equal((await build.closed).code, 0, build.output());
  }
  const unrelated = http.createServer((_req, res) => res.end("unrelated"));
  await new Promise(resolve => unrelated.listen(0, "127.0.0.1", resolve));
  const unrelatedPort = unrelated.address().port;
  try {
    const occupied = launch(process.execPath, ["scripts/pi-jobs.mjs", "start", "--port", String(unrelatedPort)], { cwd: root, env });
    const failure = await occupied.closed;
    assert.equal(failure.code, 1);
    assert.match(occupied.output(), /already in use/);
    for (const spec of [
      { command: process.execPath, args: ["scripts/pi-jobs.mjs", "start"], signal: "SIGTERM" },
      { command: process.execPath, args: ["scripts/pi-jobs.mjs", "start"], signal: "SIGINT" },
      { command: "npm", args: ["start", "--"], signal: "SIGTERM", detached: true },
    ]) {
      const port = await freePort();
      const run = launch(spec.command, [...spec.args, "--port", String(port)], { cwd: root, env, detached: spec.detached });
      let sse;
      try {
        const base = `http://127.0.0.1:${port}`;
        const { body } = await waitFor(`${base}/api/health`, (res, text) => res.status === 200 && text.includes('"ok":true'));
        assert.equal(body.root, root);
        const missing = await fetch(`${base}/api/missing-route-smoke`);
        assert.equal(missing.status, 404);
        assert.match(await missing.text(), /not found/);
        const spa = await fetch(`${base}/discover`);
        assert.equal(spa.status, 200);
        assert.match(await spa.text(), /<html/i);
        sse = http.get(`${base}/api/events`);
        sse.on("error", () => {});
        await new Promise(resolve => sse.once("response", res => res.once("data", resolve)));
        await stopChild(run, spec.signal);
        await assertPortReleased(port);
        assert.equal(await (await fetch(`http://127.0.0.1:${unrelatedPort}`)).text(), "unrelated");
      } finally {
        sse?.destroy();
        await stopChild(run, "SIGTERM", false);
      }
    }
  } finally {
    unrelated.closeAllConnections();
    await new Promise(resolve => unrelated.close(resolve));
  }
  console.log("server smoke passed: direct/group signals, SSE shutdown, port release, occupied-port safety, API/SPA routing");
} finally {
  fs.rmSync(runtime, { recursive: true, force: true });
}
