import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { runChild, childExitCode } from "./process-lifecycle.mjs";

test("preserves immediate success and genuine failure, cleaning listeners", async () => {
  const signals = new EventEmitter();
  for (const code of [0, 7, 0]) {
    const result = await runChild(process.execPath, ["-e", `process.exit(${code})`], { signals, stdio: "ignore" });
    assert.equal(childExitCode(result), code);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  }
});

test("spawn errors are nonzero and remove signal listeners", async () => {
  const signals = new EventEmitter();
  const result = await runChild("/missing-rolebound-test-executable", [], { signals });
  assert.equal(result.error.code, "ENOENT");
  assert.equal(childExitCode(result), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const code of [0, 7]) {
    test(`${signal} waits for graceful child exit and preserves code ${code}`, async () => {
      const signals = new EventEmitter();
      const result = await runChild(process.execPath, ["-e", `process.on('${signal}',()=>setTimeout(()=>process.exit(${code}),25)); console.log('ready');setInterval(()=>{},1000);`], {
        signals, stdio: ["ignore", "pipe", "ignore"],
        onChild: child => child.stdout.once("data", () => { signals.emit(signal); signals.emit(signal); }),
      });
      assert.equal(result.requestedSignal, signal);
      assert.equal(childExitCode(result), code);
      assert.equal(result.forced, false);
    });
  }
}

test("unexpected signal-only exit remains failure", async () => {
  const result = await runChild(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], { signals: new EventEmitter(), stdio: "ignore" });
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(childExitCode(result), 1);
});

test("ignoring graceful shutdown is bounded and reported as forced failure", async () => {
  const signals = new EventEmitter();
  const result = await runChild(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], {
    signals, stdio: ["ignore", "pipe", "ignore"], shutdownMs: 100,
    onChild: child => child.stdout.once("data", () => signals.emit("SIGTERM")),
  });
  assert.equal(result.forced, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(childExitCode(result), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("direct Node/tsx execution preserves spaces and Unicode in script paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolebound ü space "));
  const file = path.join(dir, "fixture ü.ts");
  fs.writeFileSync(file, "const value: number = 7; process.exit(value);\n");
  try {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const result = await runChild(process.execPath, ["--import", loader, file], { cwd: dir, stdio: "ignore", signals: new EventEmitter() });
    assert.equal(childExitCode(result), 7);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
