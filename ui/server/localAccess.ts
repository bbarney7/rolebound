import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface LocalAccessOptions { port: number; enabled?: boolean; allowDevProxy?: boolean; }
export function createLocalAccess(options: LocalAccessOptions) {
  const enabled = options.enabled ?? true;
  const token = crypto.randomBytes(32).toString("base64url");
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`]);
  if (options.allowDevProxy) { allowedHosts.add("127.0.0.1:5173"); allowedOrigins.add("http://127.0.0.1:5173"); }
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) return next();
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) return res.status(403).json({ error: "local host is not allowed" });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "origin is not allowed" });
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") return res.status(403).json({ error: "cross-site request is not allowed" });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path !== "/api/session" && req.headers["x-pi-jobs-csrf"] !== token) return res.status(403).json({ error: "csrf token required" });
    return next();
  };
  return { token, middleware };
}
