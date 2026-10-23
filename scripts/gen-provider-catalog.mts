#!/usr/bin/env node
/**
 * Regenerate ui/shared/providerCatalog.ts from pi-coding-agent 1.0.4 builtin providers.
 * Run: npx tsx scripts/gen-provider-catalog.mts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "ui/shared/providerCatalog.ts");

const DENYLIST = new Set([
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "radius",
]);

const OAUTH_ALLOWLIST = new Set(["anthropic", "openai-codex", "github-copilot"]);

type ProviderRole = "agent" | "scoring";

type CatalogAuth = {
  apiKey?: { env: string };
  oauth?: { name: string; loginLabel?: string; isSubscription?: boolean };
};

type CatalogEntry = {
  id: string;
  name: string;
  roles: ProviderRole[];
  auth: CatalogAuth;
  scrubEnv: string[];
  apiKeyEnv?: string;
};

function pickApiKeyEnv(providerId: string, scrubEnv: readonly string[]): string {
  if (providerId === "huggingface") return "HF_TOKEN";
  const apiKey = scrubEnv.find((name) => name.endsWith("_API_KEY"));
  if (apiKey) return apiKey;
  if (scrubEnv.length > 0) return scrubEnv[0];
  return `${providerId.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

async function scrubEnvForApiKey(provider: Provider): Promise<string[]> {
  if (!provider.auth?.apiKey) return [];
  const scrub = new Set<string>();
  const signal = { throwIfAborted() {} };
  const ctx = {
    env: async (name: string) => {
      scrub.add(name);
      return undefined;
    },
  };
  try {
    await provider.auth.apiKey.resolve({ ctx, credential: undefined, signal });
  } catch {
    /* resolve may throw when no credential; env names are still recorded */
  }
  return [...scrub].sort();
}

function oauthMeta(provider: Provider): CatalogAuth["oauth"] | undefined {
  if (!provider.auth?.oauth || !OAUTH_ALLOWLIST.has(provider.id)) return undefined;
  const oauth = provider.auth.oauth;
  return {
    name: oauth.name,
    ...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}),
    ...(oauth.isSubscription !== undefined ? { isSubscription: oauth.isSubscription } : {}),
  };
}

async function entryFromProvider(provider: Provider, runtime: Awaited<ReturnType<typeof ModelRuntime.create>>): Promise<CatalogEntry | null> {
  const hasApiKey = Boolean(provider.auth?.apiKey);
  const oauth = oauthMeta(provider);
  if (!hasApiKey && !oauth) return null;
  if (runtime.getModels(provider.id).length === 0 && !oauth) return null;

  const auth: CatalogAuth = {};
  let scrubEnv: string[] = [];
  let apiKeyEnv: string | undefined;
  if (hasApiKey) {
    scrubEnv = await scrubEnvForApiKey(provider);
    apiKeyEnv = pickApiKeyEnv(provider.id, scrubEnv);
    auth.apiKey = { env: apiKeyEnv };
  } else {
    scrubEnv = [];
  }
  if (oauth) auth.oauth = oauth;

  return {
    id: provider.id,
    name: provider.name,
    roles: ["agent", "scoring"],
    auth,
    scrubEnv,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
}

async function buildCatalog(): Promise<CatalogEntry[]> {
  const authDir = path.join(ROOT, ".pi-jobs", "gen-catalog-auth");
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(authDir, "auth.json");
  await fs.writeFile(authPath, "{}\n", { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const entries: CatalogEntry[] = [];
  for (const provider of runtime.getProviders()) {
    if (DENYLIST.has(provider.id)) continue;
    const entry = await entryFromProvider(provider, runtime);
    if (entry) entries.push(entry);
  }
  entries.push({
    id: "typesafe",
    name: "TypeSafe",
    roles: ["scoring"],
    auth: { apiKey: { env: "TYPESAFE_API_KEY" } },
    scrubEnv: ["TYPESAFE_API_KEY"],
    apiKeyEnv: "TYPESAFE_API_KEY",
  });
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

function renderAuth(auth: CatalogAuth): string {
  const parts: string[] = [];
  if (auth.apiKey) {
    if (auth.apiKey.env !== undefined) {
      parts.push(`apiKey: { env: ${JSON.stringify(auth.apiKey.env)} }`);
    } else {
      parts.push("apiKey: {}");
    }
  }
  if (auth.oauth) {
    const oauthParts = [`name: ${JSON.stringify(auth.oauth.name)}`];
    if (auth.oauth.loginLabel) oauthParts.push(`loginLabel: ${JSON.stringify(auth.oauth.loginLabel)}`);
    if (auth.oauth.isSubscription !== undefined) oauthParts.push(`isSubscription: ${auth.oauth.isSubscription}`);
    parts.push(`oauth: { ${oauthParts.join(", ")} }`);
  }
  return `{ ${parts.join(", ")} }`;
}

function renderEntry(e: CatalogEntry): string {
  const apiKeyEnvPart = e.apiKeyEnv !== undefined ? `, apiKeyEnv: ${JSON.stringify(e.apiKeyEnv)}` : "";
  return `  { id: ${JSON.stringify(e.id)}, name: ${JSON.stringify(e.name)}, roles: ${JSON.stringify(e.roles)}, auth: ${renderAuth(e.auth)}${apiKeyEnvPart}, scrubEnv: ${JSON.stringify(e.scrubEnv)} },`;
}

function render(entries: CatalogEntry[]): string {
  const body = entries.map(renderEntry).join("\n");
  return `/** Generated by scripts/gen-provider-catalog.mts — do not edit. */
export type ProviderRole = "agent" | "scoring";

export interface ProviderCatalogAuth {
  apiKey?: { env?: string };
  oauth?: { name: string; loginLabel?: string; isSubscription?: boolean };
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  roles: readonly ProviderRole[];
  auth: ProviderCatalogAuth;
  /** Present when the provider supports API-key auth (paste or env). */
  apiKeyEnv?: string;
  scrubEnv: readonly string[];
}

export const PI_CODING_AGENT_VERSION = "1.0.4";

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
${body}
];

export const PROVIDER_CATALOG_IDS = new Set(PROVIDER_CATALOG.map((entry) => entry.id));

export const CURSOR_PROVIDER_ENTRY: ProviderCatalogEntry = {
  id: "cursor",
  name: "Cursor",
  roles: ["agent"],
  auth: { apiKey: { env: "CURSOR_API_KEY" } },
  apiKeyEnv: "CURSOR_API_KEY",
  scrubEnv: ["CURSOR_API_KEY"],
};

export const DETECTABLE_PROVIDER_ENTRIES: readonly ProviderCatalogEntry[] = [
  ...PROVIDER_CATALOG,
  CURSOR_PROVIDER_ENTRY,
];

export const OPENAI_COMPATIBLE_ENTRY: ProviderCatalogEntry = {
  id: "openai-compatible",
  name: "OpenAI compatible",
  roles: ["agent", "scoring"],
  auth: { apiKey: {} },
  scrubEnv: [],
};

export function catalogEntryFor(providerId: string): ProviderCatalogEntry | undefined {
  if (providerId === "cursor") return CURSOR_PROVIDER_ENTRY;
  if (providerId === "openai-compatible") return OPENAI_COMPATIBLE_ENTRY;
  return PROVIDER_CATALOG.find((entry) => entry.id === providerId);
}

export function providerSupportsApiKey(providerId: string): boolean {
  const entry = catalogEntryFor(providerId);
  return Boolean(entry?.auth.apiKey);
}

export function providerSupportsOAuth(providerId: string): boolean {
  const entry = catalogEntryFor(providerId);
  return Boolean(entry?.auth.oauth);
}

export const ALL_SCRUB_ENV_NAMES: readonly string[] = [
  ...new Set([
    ...PROVIDER_CATALOG.flatMap((entry) => entry.scrubEnv),
    ...CURSOR_PROVIDER_ENTRY.scrubEnv,
    "CURSOR_API_KEY",
  ]),
].sort();

export const POPULAR_PROVIDER_IDS = ["openai", "anthropic", "google", "openrouter", "cursor"] as const;
`;
}

async function main() {
  const entries = await buildCatalog();
  const text = render(entries);
  await fs.writeFile(OUT, text, "utf8");
  console.log(`Wrote ${OUT} (${entries.length} registry providers)`);
}

await main();
