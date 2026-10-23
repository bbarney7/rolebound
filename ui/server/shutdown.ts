import type { Server } from "node:http";

/** Close the listener and SSE sockets while run disposal retains child ownership. */
export function createShutdown(server: Server, dispose: () => Promise<void>, timeoutMs = 12_000) {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    // Fence new run starts synchronously, before any asynchronous cleanup.
    const disposing = dispose();
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
    pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server shutdown exceeded its cleanup deadline")), timeoutMs);
      Promise.all([disposing, closed]).then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    return pending;
  };
}
