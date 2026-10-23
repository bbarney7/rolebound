#!/usr/bin/env node
/**
 * Loopback OpenAI-compatible chat API that emits scripted tool batches per request (SSE).
 */
import http from "node:http";

/**
 * @param {{ id?: string, name: string, arguments: Record<string, unknown> | string } | Array<{ id?: string, name: string, arguments: Record<string, unknown> | string }>} tool
 */
export function toolCallChunkFrames(tool) {
  const tools = Array.isArray(tool) ? tool : [tool];
  return [
    {
      id: "chatcmpl-pjr15-scripted",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: tools.map((call, index) => ({
              index,
              id: call.id ?? `call_scripted_${index + 1}`,
              type: "function",
              function: { name: call.name, arguments: "" },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-pjr15-scripted",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: tools.map((call, index) => ({
              index,
              function: {
                arguments:
                  typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-pjr15-scripted",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

export function textAnswerFrames(text) {
  return [
    {
      id: "chatcmpl-pjr15-scripted",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-pjr15-scripted",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

function writeSse(res, frames) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * @param {object} options
 * @param {string[]} [options.modelIds]
 * @param {Array<{ tool?: { name: string, arguments?: Record<string, unknown> | string }, tools?: Array<{ name: string, arguments?: Record<string, unknown> | string }>, text?: string, httpStatus?: number, delayMs?: number, rawBody?: string, holdUntilReleased?: boolean }>} options.steps
 * @param {(index: number) => void | Promise<void>} [options.onAfterStep]
 */
export function createScriptedModelServer({ modelIds = ["scripted"], steps: initialSteps, onAfterStep } = { steps: [] }) {
  let steps = initialSteps ?? [];
  let index = 0;
  /** @type {Array<{ method: string, path: string, headers: Record<string, string>, body: string }>} */
  const capturedRequests = [];
  /** @type {Array<() => void>} */
  const holdQueue = [];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];

    if (req.method === "GET" && (pathOnly === "/models" || pathOnly === "/v1/models")) {
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      capturedRequests.push({ method: req.method, path: pathOnly, headers, body: "" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }));
      return;
    }

    if (req.method === "GET" && pathOnly === "/__test__/requests") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(capturedRequests));
      return;
    }

    if (req.method !== "POST" || !pathOnly.startsWith("/v1/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readBody(req);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }
    capturedRequests.push({ method: req.method, path: pathOnly, headers, body });

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    if (!parsed.stream) {
      res.writeHead(400);
      res.end("stream required");
      return;
    }

    const step = steps[index];
    if (!step) {
      writeSse(res, textAnswerFrames("done"));
      return;
    }
    index += 1;
    if (onAfterStep) await onAfterStep(index - 1);

    if (step.delayMs) await sleep(step.delayMs);

    if (step.holdUntilReleased) {
      await new Promise((resolve) => {
        holdQueue.push(resolve);
      });
    }

    if (step.httpStatus !== undefined && step.httpStatus !== 200) {
      res.writeHead(step.httpStatus);
      res.end(step.rawBody ?? "");
      return;
    }

    if (step.rawBody !== undefined) {
      res.writeHead(step.httpStatus ?? 200);
      res.end(step.rawBody);
      return;
    }

    if (step.tools || step.tool) {
      writeSse(res, toolCallChunkFrames(step.tools ?? step.tool));
      return;
    }
    writeSse(res, textAnswerFrames(step.text ?? "ok"));
  });

  server.capturedRequests = capturedRequests;
  Object.defineProperty(server, "pendingHolds", {
    get() {
      return holdQueue.length;
    },
  });
  server.releaseHold = () => {
    const release = holdQueue.shift();
    if (release) release();
  };
  server.resetScript = () => {
    index = 0;
  };
  server.setSteps = (nextSteps) => {
    steps = nextSteps;
    index = 0;
  };

  return server;
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
