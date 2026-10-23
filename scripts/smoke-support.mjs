import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function assertPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  await new Promise(resolve => server.close(resolve));
}

export function launch(command, args, opts) {
  const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exited = false;
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  const closed = new Promise(resolve => {
    let error;
    child.once("error", value => { error = value; });
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal, error }); });
  });
  return { child, closed, output: () => output, exited: () => exited, group: opts?.detached === true };
}

export async function waitFor(url, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const text = await response.text();
      if (predicate(response, text)) return { response, text, body: JSON.parse(text) };
    } catch { /* startup not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`startup timed out at ${new URL(url).pathname}`);
}

export async function stopChild(run, signal = "SIGTERM", verify = true) {
  const send = value => {
    if (run.exited()) return;
    if (run.group) process.kill(-run.child.pid, value);
    else run.child.kill(value);
  };
  if (!run.exited()) send(signal);
  let timer;
  try {
    const result = await Promise.race([
      run.closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("smoke child shutdown timed out")), 20_000); }),
    ]);
    if (verify) {
      assert.equal(result.error, undefined, run.output());
      if (run.group && result.signal === signal) return result; // terminal signalled npm itself; listener checks still required
      assert.equal(result.code, 0, `unclean shutdown: ${JSON.stringify(result)} ${run.output()}`);
    }
    return result;
  } catch (error) {
    if (!run.exited()) {
      send("SIGKILL");
      await Promise.race([run.closed, new Promise((_, reject) => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error("smoke child did not reap after SIGKILL")), 2000);
      })]);
    }
    throw error;
  } finally { clearTimeout(timer); }
}
