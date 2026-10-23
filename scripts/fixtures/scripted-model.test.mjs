import assert from "node:assert/strict";
import test from "node:test";
import {
  close,
  createScriptedModelServer,
  listen,
  toolCallChunkFrames,
} from "./scripted-model.mjs";

test("toolCallChunkFrames emits OpenAI SSE tool_call deltas", () => {
  const frames = toolCallChunkFrames({
    id: "call_abc",
    name: "mcp__job_playwright__browser_click",
    arguments: { element: "Submit", ref: "e1" },
  });
  assert.equal(frames.length, 3);
  assert.equal(frames[0].object, "chat.completion.chunk");
  const first = frames[0].choices[0].delta.tool_calls[0];
  assert.equal(first.type, "function");
  assert.equal(first.id, "call_abc");
  assert.equal(first.function.name, "mcp__job_playwright__browser_click");
  assert.equal(first.function.arguments, "");
  const second = frames[1].choices[0].delta.tool_calls[0];
  assert.equal(second.function.arguments, JSON.stringify({ element: "Submit", ref: "e1" }));
  assert.equal(frames[2].choices[0].finish_reason, "tool_calls");
});

test("toolCallChunkFrames emits several calls in one assistant message", () => {
  const tools = [
    { name: "browser_navigate", arguments: { url: "https://example.invalid/" } },
    { name: "browser_click", arguments: { ref: "e1" } },
  ];
  const frames = toolCallChunkFrames(tools);
  assert.equal(frames.length, 3);
  const calls = frames[0].choices[0].delta.tool_calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.index), [0, 1]);
  assert.equal(new Set(calls.map((call) => call.id)).size, 2);
  assert.deepEqual(calls.map((call) => call.function.name), tools.map((tool) => tool.name));
  assert.deepEqual(
    frames[1].choices[0].delta.tool_calls.map((call) => call.function.arguments),
    tools.map((tool) => JSON.stringify(tool.arguments)),
  );
  assert.equal(frames[2].choices[0].finish_reason, "tool_calls");
});

test("GET /models and /v1/models return configured model ids", async () => {
  const server = createScriptedModelServer({ modelIds: ["scripted-a", "scripted-b"], steps: [] });
  await listen(server);
  const port = server.address().port;
  const paths = ["/models", "/v1/models"];
  for (const path of paths) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.map((m) => m.id).sort(), ["scripted-a", "scripted-b"]);
  }
  await close(server);
});

test("captures chat completion requests", async () => {
  const server = createScriptedModelServer({
    modelIds: ["scripted"],
    steps: [{ text: "ok" }],
  });
  await listen(server);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test": "1" },
    body: JSON.stringify({ stream: true, model: "scripted", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(server.capturedRequests.length, 1);
  const captured = server.capturedRequests[0];
  assert.equal(captured.method, "POST");
  assert.equal(captured.path, "/v1/chat/completions");
  assert.equal(captured.headers["x-test"], "1");
  assert.match(captured.body, /"content":"hi"/);
  await close(server);
});

test("per-request status, delay, malformed body, and hold barrier", async () => {
  const server = createScriptedModelServer({
    modelIds: ["scripted"],
    steps: [
      { httpStatus: 401 },
      { httpStatus: 429, delayMs: 30 },
      { httpStatus: 500 },
      { rawBody: "{not-json", httpStatus: 200 },
      { holdUntilReleased: true, text: "after-hold" },
    ],
  });
  await listen(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/v1/chat/completions`;
  const post = (body = { stream: true, model: "scripted", messages: [] }) =>
    fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await post()).status, 401);
  const t0 = Date.now();
  assert.equal((await post()).status, 429);
  assert.ok(Date.now() - t0 >= 25);
  assert.equal((await post()).status, 500);
  const malformed = await post();
  assert.equal(malformed.status, 200);
  assert.equal(await malformed.text(), "{not-json");

  const holdPromise = post();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(server.pendingHolds, 1);
  server.releaseHold();
  const held = await holdPromise;
  assert.equal(held.status, 200);
  const heldText = await held.text();
  assert.match(heldText, /after-hold/);
  assert.equal(server.pendingHolds, 0);
  await close(server);
});
