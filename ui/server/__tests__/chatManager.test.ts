import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "../runs/runManager";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";

const fixtures: string[] = [];
const managers: RunManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); for (const root of fixtures.splice(0)) await rmFixtureWorkspace(root); });
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("chat did not reach expected state"); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture() {
  const root = await makeFixtureWorkspace(); fixtures.push(root);
  const fakePi = fileURLToPath(new URL("./fakePi.mjs", import.meta.url));
  const manager = new RunManager({ root, command: process.execPath, args: () => [fakePi], model: "fake/model", secrets: () => [], env: { ...process.env }, idleGraceMs: 50, killGraceMs: 50 });
  managers.push(manager); return { root, manager };
}
it("chat keeps its child alive for start, reply, reply, replay, abort without a web server", async () => {
  const { manager } = await fixture();
  const started = await manager.start({ kind: "chat", message: "hello" });
  expect(started.ok).toBe(true);
  await waitFor(() => manager.current()?.status === "waiting");
  for (const message of ["second", "third"]) {
    expect(manager.reply(message).ok).toBe(true);
    await waitFor(() => manager.events().some(e => e.type === "notify" && e.message === `prompt:${message}|steer=false`));
    await waitFor(() => manager.current()?.status === "waiting");
  }
  expect(manager.current()?.endedAt).toBeNull();
  const replay: unknown[] = [];
  manager.subscribe(0, e => replay.push(e))();
  expect(replay).toEqual(manager.events());
  expect(manager.events().filter(e => e.type === "user").map(e => e.message)).toEqual(["hello", "second", "third"]);
  expect(manager.abort().ok).toBe(true);
  await waitFor(() => manager.events().some(e => e.type === "exit"));
  expect(manager.current()?.status).toBe("stopped");
});
it("chat sets its child run kind and can finish explicitly", async () => {
  const { manager } = await fixture();
  expect((await manager.start({ kind: "chat", message: "env-dump" })).ok).toBe(true);
  await waitFor(() => manager.events().some(e => e.type === "notify" && e.message.startsWith("env:")));
  const env = manager.events().find(e => e.type === "notify" && e.message.startsWith("env:"));
  expect(env).toMatchObject({ message: expect.stringContaining("|chat|") });
  await waitFor(() => manager.current()?.status === "waiting");
  expect((await manager.finish()).ok).toBe(true);
  await waitFor(() => manager.current()?.status === "done");
});
