import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createShutdown } from "../shutdown";

describe("server shutdown", () => {
  it("closes SSE/listener and waits for disposal, idempotently", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const request = http.get(`http://127.0.0.1:${port}`);
    request.on("error", () => {});
    await new Promise<void>(resolve => request.once("response", res => res.once("data", () => resolve())));
    let release!: () => void;
    const disposal = new Promise<void>(resolve => { release = resolve; });
    const shutdown = createShutdown(server, () => disposal);
    const result = shutdown();
    expect(shutdown()).toBe(result);
    expect(server.listening).toBe(false);
    release();
    await result;
    const rebound = http.createServer();
    await new Promise<void>(resolve => rebound.listen(port, "127.0.0.1", resolve));
    await new Promise<void>(resolve => rebound.close(() => resolve()));
    request.destroy();
  });

  it("propagates disposal failure", async () => {
    const server = http.createServer();
    await expect(createShutdown(server, () => Promise.reject(new Error("forced run shutdown")))()).rejects.toThrow("forced run shutdown");
  });

  it("bounds a stalled disposal", async () => {
    const server = http.createServer();
    await expect(createShutdown(server, () => new Promise(() => {}), 25)()).rejects.toThrow("deadline");
  });
});
