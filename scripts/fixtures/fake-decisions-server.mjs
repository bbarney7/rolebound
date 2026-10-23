#!/usr/bin/env node
/**
 * Loopback Jev / TypeSafe decisions API for tests.
 */
import http from "node:http";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function typesafeWireAnswers(answers) {
  const wired = {};
  for (const [id, value] of Object.entries(answers)) {
    if (id === "fit" && value && typeof value === "object") {
      const fit = value;
      let score = typeof fit.score === "number" ? fit.score : 0;
      if (fit.probabilities && typeof fit.probabilities === "object") {
        let best = 0;
        let bestProb = -1;
        for (const [key, prob] of Object.entries(fit.probabilities)) {
          const index = Number(key);
          if (Number.isInteger(index) && index >= 0 && index <= 4 && typeof prob === "number" && prob > bestProb) {
            bestProb = prob;
            best = index;
          }
        }
        score = typeof fit.score === "number" ? fit.score : best;
      }
      wired[id] = {
        type: "score",
        score,
        confidence: typeof fit.confidence === "number" ? fit.confidence : 0.9,
      };
      continue;
    }
    let probability = 0.5;
    if (typeof value === "number") probability = value;
    else if (value && typeof value === "object") {
      if (typeof value.probability === "number") probability = value.probability;
      else if (typeof value.noul === "number") probability = value.noul;
    }
    wired[id] = { type: "noul", noul: probability, confidence: 0.9 };
  }
  return wired;
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
 * @param {string} [options.decisionsPath]
 * @param {Array<{ httpStatus?: number, delayMs?: number, rawBody?: string, answers?: Record<string, unknown>, usage?: { cost?: number }, holdUntilReleased?: boolean }>} [options.steps]
 */
export function createFakeDecisionsServer({ decisionsPath = "/api/alpha/decisions", steps: initialSteps = [] } = {}) {
  let steps = initialSteps;
  let index = 0;
  /** @type {Array<{ method: string, path: string, headers: Record<string, string>, body: string }>} */
  const capturedRequests = [];
  /** @type {Array<() => void>} */
  const holdQueue = [];
  /** @type {Array<() => void>} */
  const holdBeginWaiters = [];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];

    if (req.method === "GET" && pathOnly === "/__test__/requests") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(capturedRequests));
      return;
    }

    if (req.method !== "POST" || pathOnly !== decisionsPath) {
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

    const step = steps[index];
    index += 1;
    if (!step) {
      res.writeHead(500);
      res.end("no step");
      return;
    }

    if (step.delayMs) await sleep(step.delayMs);

    if (step.holdUntilReleased) {
      for (const notify of holdBeginWaiters.splice(0)) notify();
      await new Promise((resolve) => {
        holdQueue.push(resolve);
      });
    }

    const status = step.httpStatus ?? 200;
    if (status !== 200) {
      res.writeHead(status);
      res.end(step.rawBody ?? "");
      return;
    }

    if (step.rawBody !== undefined) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(step.rawBody);
      return;
    }

    const rawAnswers = step.answers ?? {};
    const answers =
      decisionsPath === "/v1/systemone" ? typesafeWireAnswers(rawAnswers) : rawAnswers;
    const payload = {
      answers,
      ...(step.usage ? { usage: step.usage } : {}),
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  });

  server.capturedRequests = capturedRequests;
  server.whenHoldBegins = () =>
    new Promise((resolve) => {
      holdBeginWaiters.push(resolve);
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
