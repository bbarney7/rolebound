import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import type { ProviderHostDeps } from "./providers/hostDeps";
import { createShutdown } from "./shutdown";

export function startUiServer(options: {
  root: string;
  host: string;
  port: number;
  demo: boolean;
  allowDevProxy: boolean;
  providerHost?: ProviderHostDeps;
}) {
  const { root, host, port } = options;
  const app = createApp(root, {
    demo: options.demo,
    security: { enabled: true, port, allowDevProxy: options.allowDevProxy },
    ...(options.providerHost ? { providerHost: options.providerHost } : {}),
  });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
    return next();
  });
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, fallthrough: true }));
    app.get("/{*splat}", (req, res, next) =>
      req.path.startsWith("/api/") ? next() : res.sendFile(path.join(dist, "index.html")),
    );
  }

  const server = app
    .listen(port, host, () => {
      console.log(`[pi-jobs-ui] workspace: ${root}`);
      console.log(`[pi-jobs-ui] API listening on http://${host}:${port}`);
    })
    .on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[pi-jobs-ui] port ${port} is already in use — is the server already running?`);
        process.exit(1);
      }
      throw err;
    });

  const shutdown = createShutdown(server, () => app.runs.dispose());
  const stop = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error(`[pi-jobs-ui] shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
        process.exit(1);
      },
    );
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  process.on("exit", () => app.runs.disposeSync());
  return { app, server };
}
