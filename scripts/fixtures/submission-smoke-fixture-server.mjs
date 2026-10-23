import http from "node:http";

/** Loopback fixture for submission-smoke: counts mutating MCP tool calls. */
export function createSubmissionSmokeFixtureServer() {
  let submitCount = 0;
  let fillCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/counts") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ submitCount, fillCount }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      submitCount = 0;
      fillCount = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/tool") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          const { tool } = JSON.parse(body);
          if (tool === "browser_click" || tool === "browser_run_code_unsafe") submitCount += 1;
          if (tool === "browser_type" || tool === "browser_fill_form") fillCount += 1;
        } catch {
          // ignore
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, getSubmitCount: () => submitCount };
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
