export type RouteView = "chat" | "overview" | "discover" | "applications" | "queue" | "run" | "profile" | "instructions" | "setup" | "settings" | "accounts" | "not-found";

export type AppRoute = {
  view: RouteView;
  slug?: string;
  accountHost?: string;
  tab: string;
  search: string;
  status: string;
  applyState: string;
  from: string;
  to: string;
};

const safeSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/;

export function parseRoute(url: string): AppRoute {
  const parsed = new URL(url, "http://127.0.0.1");
  const parts = parsed.pathname.split("/").filter(Boolean);
  const query = parsed.searchParams;
  const base = {
    tab: query.get("tab") ?? "",
    search: query.get("q") ?? "",
    status: query.get("status") ?? "all",
    applyState: query.get("apply") ?? "all",
    from: query.get("from") ?? "",
    to: query.get("to") ?? "",
  };
  if (parts.length === 0) return { view: "chat", ...base };
  if (parts.length === 1 && parts[0] === "today") return { view: "overview", ...base };
  if (parts.length === 1 && parts[0] === "discover") return { view: "discover", ...base };
  if (parts.length === 1 && parts[0] === "queue") return { view: "queue", ...base };
  if (parts.length === 1 && parts[0] === "profile") return { view: "profile", ...base };
  if (parts.length === 1 && parts[0] === "instructions") return { view: "instructions", ...base };
  if (parts.length === 1 && parts[0] === "setup") return { view: "setup", ...base };
  if (parts.length === 1 && parts[0] === "settings") return { view: "settings", ...base };
  if (parts.length === 2 && parts[0] === "settings" && parts[1] === "accounts") return { view: "accounts", ...base };
  if (parts.length === 3 && parts[0] === "settings" && parts[1] === "accounts" && safeSegment.test(parts[2])) return { view: "accounts", accountHost: parts[2], ...base };
  if (parts.length === 2 && parts[0] === "runs" && parts[1] === "current") return { view: "chat", ...base };
  if (parts.length === 1 && parts[0] === "applications") return { view: "applications", ...base };
  if (parts.length === 2 && parts[0] === "applications" && safeSegment.test(parts[1])) return { view: "applications", slug: parts[1], ...base };
  return { view: "not-found", ...base };
}

export function pathForRoute(route: Pick<AppRoute, "view" | "search" | "status" | "applyState" | "from" | "to"> & { slug?: string; accountHost?: string; tab?: string }): string {
  let path =
    route.view === "chat"
      ? "/"
      : route.view === "overview"
        ? "/today"
        : route.view === "accounts"
          ? "/settings/accounts"
          : `/${route.view}`;
  if (route.view === "applications" && route.slug) path += `/${encodeURIComponent(route.slug)}`;
  if (route.view === "accounts" && route.accountHost) path += `/${encodeURIComponent(route.accountHost)}`;
  const query = new URLSearchParams();
  if (route.tab) query.set("tab", route.tab);
  if (route.search) query.set("q", route.search);
  if (route.status && route.status !== "all") query.set("status", route.status);
  if (route.applyState && route.applyState !== "all") query.set("apply", route.applyState);
  if (route.from) query.set("from", route.from);
  if (route.to) query.set("to", route.to);
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
