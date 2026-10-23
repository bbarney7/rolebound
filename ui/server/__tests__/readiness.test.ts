import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FIXTURE_LIVE_SHAPED_PROFILE,
  makeFixtureWorkspace,
  rmFixtureWorkspace,
  SENTINEL_PASSWORD,
} from "./helpers";
import { AUTO_SUBMIT_POLICY_VERSION } from "../../shared/autoSubmitPolicy";
import {
  AcknowledgementValidationError,
  computeReadiness,
  parseAcknowledgementBody,
  recordSupervisedAcknowledgement,
  SUPERVISED_ACKNOWLEDGEMENT_TOKEN,
} from "../readiness";
import { createApp } from "../app";
import {
  providerAlias,
  setConnectionCredential,
  setModelRuntimeFactoryForTests,
} from "../providers/providerService";
import { modifyAuthFile } from "../providers/authStoreFile";

const agentConnection = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  label: "Agent",
  provider: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9001/v1",
};

async function seedReadySettings(root: string, acknowledged = true) {
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    connections: [agentConnection],
    agent: { connectionId: agentConnection.id, modelId: "agent-model" },
    scoring: { connectionId: agentConnection.id, modelId: "agent-model" },
    captcha: {},
  }));
  await setConnectionCredential(root, agentConnection.id, "agent-key");
  const state: Record<string, unknown> = {
    applications: [{ slug: "preserve-me", status: "queued" }],
    addresses: { denver: { street: "1 Main", city: "Denver", state: "CO", zip: "80202" } },
  };
  if (acknowledged) {
    state.acknowledged_at = "2026-01-01T00:00:00.000Z";
    state.acknowledged_policy = AUTO_SUBMIT_POLICY_VERSION;
  }
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
}

async function seedApplyReadyExceptAck(root: string) {
  await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
  await seedReadySettings(root, false);
}

describe("server readiness", () => {
  it("cannot be falsely completed when the required model/profile data is missing", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "settings.json"), "{}\n");
      await fs.rm(path.join(root, "profile.md"));
      await fs.rm(path.join(root, "resumes"), { recursive: true });
      const value = await computeReadiness(root);
      expect(value.browseReady).toBe(true);
      expect(value.applyReady).toBe(false);
      expect(value.steps.find((s) => s.id === "connection")?.blockers.map((b) => b.code)).toContain("AGENT_MODEL_MISSING");
      expect(value.steps.find((s) => s.id === "profile")?.blockers.map((b) => b.href)).toContain("/profile");
      expect(value.steps.find((s) => s.id === "resume")?.blockers[0].href).toContain("tab=resumes");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("treats CAPTCHA as optional and never uses it in apply readiness", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const value = await computeReadiness(root);
      expect(value.captchaOptional).toBe(true);
      expect(value.steps).toHaveLength(5);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("rejects placeholder identity values the parser would treat as unset", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "profile")?.blockers.map((b) => b.code)).toEqual([
        "NAME_MISSING",
        "EMAIL_MISSING",
        "PROFILE_PLACEHOLDERS",
      ]);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("rejects invalid email shapes even when non-empty", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE.replace("jane@example.com", "not-an-email"));
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "profile")?.blockers.map((b) => b.code)).toContain("EMAIL_MISSING");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("accepts canonical greenhouse:slug targets without ## ATS headings", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
      const value = await computeReadiness(root);
      expect(value.discoverReady).toBe(true);
      expect(value.steps.find((s) => s.id === "targets")?.complete).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("does not treat region-only resumes as apply-ready without default.pdf or global override", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
      await seedReadySettings(root);
      await fs.rm(path.join(root, "resumes", "default.pdf"));
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "resume")?.blockers.map((b) => b.code)).toContain("RESUME_MISSING");
      expect(value.applyReady).toBe(false);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("blocks apply-ready until supervised acknowledgement is recorded", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await seedApplyReadyExceptAck(root);
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "readiness")?.blockers.map((b) => b.code)).toContain("ACKNOWLEDGEMENT_MISSING");
      expect(value.applyReady).toBe(false);
      expect(value.acknowledgement).toMatchObject({ at: null, policy: null, current: AUTO_SUBMIT_POLICY_VERSION });
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("legacy acknowledgement blocks apply until re-acknowledged, then apply-ready", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
      await seedReadySettings(root, false);
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify({
          applications: [],
          addresses: {},
          acknowledged_at: "2020-01-01T00:00:00.000Z",
        }),
      );
      const legacy = await computeReadiness(root);
      expect(legacy.applyReady).toBe(false);
      expect(legacy.steps.find((s) => s.id === "readiness")?.blockers[0]).toMatchObject({
        code: "ACKNOWLEDGEMENT_LEGACY",
        message: "Rolebound now states plainly that it submits applications automatically. Review and acknowledge again.",
      });

      const after = await recordSupervisedAcknowledgement(root);
      expect(after.applyReady).toBe(true);
      expect(after.acknowledgement.policy).toBe(AUTO_SUBMIT_POLICY_VERSION);
      const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8")) as {
        acknowledged_policy?: string;
      };
      expect(state.acknowledged_policy).toBe(AUTO_SUBMIT_POLICY_VERSION);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("marks apply-ready when default.pdf exists and identity is valid", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
      await seedReadySettings(root);
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "profile")?.complete).toBe(true);
      expect(value.steps.find((s) => s.id === "resume")?.complete).toBe(true);
      expect(value.applyReady).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("ignores hostile global pi auth during agent model metadata validation", async () => {
    const root = await makeFixtureWorkspace();
    const hostileRoot = await fs.mkdtemp(path.join(path.dirname(root), "pi-hostile-agent-"));
    try {
      const hostileAgent = path.join(hostileRoot, "agent");
      await fs.mkdir(hostileAgent, { recursive: true });
      await fs.writeFile(path.join(hostileAgent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "HOSTILE" } }));
      await fs.writeFile(path.join(hostileAgent, "models.json"), JSON.stringify({
        providers: { openai: { baseUrl: "https://evil.invalid/v1", api: "openai-completions", models: [] } },
      }));
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
      await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        connections: [{ id: "123e4567-e89b-12d3-a456-426614174002", label: "OpenAI", provider: "openai" }],
        agent: { connectionId: "123e4567-e89b-12d3-a456-426614174002", modelId: "gpt-4o-mini" },
        scoring: null,
        captcha: {},
      }));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = hostileAgent;
      try {
        const value = await computeReadiness(root);
        expect(value.steps.find((s) => s.id === "connection")?.blockers.map((b) => b.code)).not.toContain("MODEL_UNAVAILABLE");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    } finally {
      await rmFixtureWorkspace(root);
      await fs.rm(hostileRoot, { recursive: true, force: true });
    }
  });
});

describe("parseAcknowledgementBody", () => {
  it("accepts only the exact ACKNOWLEDGE token", () => {
    parseAcknowledgementBody({ acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN });
    expect(() => parseAcknowledgementBody({})).toThrow(AcknowledgementValidationError);
    expect(() => parseAcknowledgementBody({ acknowledgement: "yes" })).toThrow(AcknowledgementValidationError);
    expect(() => parseAcknowledgementBody(null)).toThrow(AcknowledgementValidationError);
  });
});

describe("recordSupervisedAcknowledgement", () => {
  it("is idempotent and preserves unrelated state fields", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await seedApplyReadyExceptAck(root);
      const first = await recordSupervisedAcknowledgement(root);
      const acknowledgedAt = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8")).acknowledged_at as string;
      expect(first.applyReady).toBe(true);
      const second = await recordSupervisedAcknowledgement(root);
      const after = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8")) as {
        acknowledged_at?: string;
        acknowledged_policy?: string;
        applications?: unknown[];
        addresses?: Record<string, unknown>;
      };
      expect(after.acknowledged_at).toBe(acknowledgedAt);
      expect(after.acknowledged_policy).toBe(AUTO_SUBMIT_POLICY_VERSION);
      expect(second.applyReady).toBe(true);
      expect(after.applications).toEqual([{ slug: "preserve-me", status: "queued" }]);
      expect(after.addresses?.denver).toMatchObject({ city: "Denver" });
    } finally {
      await rmFixtureWorkspace(root);
    }
  });
});

describe("POST /api/readiness/acknowledgement", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let base = "";

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rmFixtureWorkspace(root);
    root = undefined;
    server = undefined;
    base = "";
  });

  async function startServer(security = false) {
    root = await makeFixtureWorkspace();
    await seedApplyReadyExceptAck(root);
    const app = createApp(root, { security: { enabled: security } });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const { port } = server!.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    return base;
  }

  async function postAck(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}/api/readiness/acknowledgement`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("rejects missing or false acknowledgement bodies", async () => {
    await startServer();
    expect((await postAck({})).status).toBe(400);
    expect((await postAck({ acknowledgement: "yes" })).status).toBe(400);
    const bad = await postAck({});
    expect(await bad.json()).toMatchObject({ code: "ACKNOWLEDGEMENT_REQUIRED" });
    expect(bad.headers.get("cache-control")).toBe("no-store");
    const ready = await computeReadiness(root!);
    expect(ready.applyReady).toBe(false);
  });

  it("records acknowledgement, returns updated readiness, and does not start a run", async () => {
    await startServer();
    const res = await postAck({ acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    const body = JSON.parse(text) as { applyReady: boolean };
    expect(body.applyReady).toBe(true);
    const run = await fetch(`${base}/api/runs/current`);
    expect(run.status).toBe(200);
    const runBody = await run.json() as { run: unknown };
    expect(runBody.run).toBeNull();
  });

  it("repeats are idempotent under concurrent state edits", async () => {
    await startServer();
    const [first, second] = await Promise.all([
      postAck({ acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN }),
      postAck({ acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const state = JSON.parse(await fs.readFile(path.join(root!, "state.json"), "utf8")) as {
      acknowledged_at?: string;
      applications?: unknown[];
      addresses?: Record<string, unknown>;
    };
    expect(state.acknowledged_at).toBeTruthy();
    expect(state.applications).toEqual([{ slug: "preserve-me", status: "queued" }]);
    expect(state.addresses?.denver).toMatchObject({ zip: "80202" });
  });

  it("requires CSRF when local security is enabled", async () => {
    const port = 4791;
    root = await makeFixtureWorkspace();
    await seedApplyReadyExceptAck(root);
    const app = createApp(root, { security: { enabled: true, port } });
    server = app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${port}`;
    const session = await fetch(`${base}/api/session`, { headers: { host: `127.0.0.1:${port}` } });
    const token = (await session.json() as { csrfToken: string }).csrfToken;
    expect((await postAck({ acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN })).status).toBe(403);
    const ok = await postAck(
      { acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN },
      { host: `127.0.0.1:${port}`, "x-pi-jobs-csrf": token },
    );
    expect(ok.status).toBe(200);
  });
});

describe("score readiness", () => {
  it("reports TARGETS_PLACEHOLDER when only example-co slugs are configured", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(
        path.join(root, "targets.md"),
        "# Gather targets\n\n## Greenhouse\n\n- example-co\n\n## Ashby\n\n- example-co\n\n## Lever\n\n- example-co\n",
      );
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "targets")?.blockers.map((b) => b.code)).toContain("TARGETS_PLACEHOLDER");
      expect(value.discoverReady).toBe(false);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("exposes scoreBlockers for template identity placeholders", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const value = await computeReadiness(root);
      expect(value.scoreBlockers.map((b) => b.code)).toContain("PROFILE_PLACEHOLDERS");
      expect(value.scoreReady).toBe(false);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("blocks score readiness when profile.md is missing", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.rm(path.join(root, "profile.md"));
      const openai = {
        id: "123e4567-e89b-12d3-a456-426614174052",
        label: "OpenAI",
        provider: "openai" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [openai],
          agent: { connectionId: openai.id, modelId: "gpt-4o-mini" },
          scoring: { connectionId: openai.id, modelId: "gpt-4o-mini" },
          captcha: {},
        }),
      );
      await setConnectionCredential(root, openai.id, "FIXTURE-SECRET-do-not-leak");
      const value = await computeReadiness(root);
      expect(value.scoreReady).toBe(false);
      expect(value.scoreBlockers.some((b) => b.code === "PROFILE_MISSING")).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("blocks score readiness when candidate summary cannot be composed", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await fs.writeFile(
        path.join(root, "profile.md"),
        `# Applicant Profile

## Identity

- **Email:** jane@example.com

## Work history

`,
      );
      const openai = {
        id: "123e4567-e89b-12d3-a456-426614174051",
        label: "OpenAI",
        provider: "openai" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [openai],
          agent: { connectionId: openai.id, modelId: "gpt-4o-mini" },
          scoring: { connectionId: openai.id, modelId: "gpt-4o-mini" },
          captcha: {},
        }),
      );
      await setConnectionCredential(root, openai.id, "FIXTURE-SECRET-do-not-leak");
      const value = await computeReadiness(root);
      expect(value.scoreReady).toBe(false);
      expect(value.scoreBlockers.some((b) => b.code === "CANDIDATE_SUMMARY_MISSING")).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("is not score-ready when the scorer is configured but the agent model is missing", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const scorer = {
        id: "123e4567-e89b-12d3-a456-426614174011",
        label: "Scorer",
        provider: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:9002/v1",
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [scorer],
          scoring: { connectionId: scorer.id, modelId: "score-model" },
          captcha: {},
        }),
      );
      await setConnectionCredential(root, scorer.id, "score-key");
      const value = await computeReadiness(root);
      expect(value.scoreReady).toBe(false);
      expect(value.scoreBlockers.map((b) => b.code)).toContain("AGENT_MODEL_MISSING");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("clears SCORING_MODEL_MISSING when cursor agent has a Jev scoring override", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const cursor = {
        id: "123e4567-e89b-12d3-a456-426614174080",
        label: "Cursor",
        provider: "cursor" as const,
      };
      const openrouter = {
        id: "123e4567-e89b-12d3-a456-426614174081",
        label: "OpenRouter",
        provider: "openrouter" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [cursor, openrouter],
          agent: { connectionId: cursor.id, modelId: "composer-2.5" },
          scoring: { connectionId: openrouter.id, modelId: "typesafe/jev-1.13" },
          captcha: {},
        }),
      );
      await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
      await setConnectionCredential(root, cursor.id, "cursor-key");
      await setConnectionCredential(root, openrouter.id, "or-key");
      const value = await computeReadiness(root);
      expect(value.scoreBlockers.some((b) => b.code === "SCORING_MODEL_MISSING")).toBe(false);
      // A score run still starts pi with the Cursor agent, so Cursor's Node 24 floor applies.
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      if (nodeMajor >= 24) {
        expect(value.scoreReady).toBe(true);
      } else {
        expect(value.scoreReady).toBe(false);
        expect(value.scoreBlockers.every((b) => /Node 24/.test(b.message))).toBe(true);
      }
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("blocks cursor agent without a scoring override and warns on unknown cursor models", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const cursor = {
        id: "123e4567-e89b-12d3-a456-426614174020",
        label: "Cursor",
        provider: "cursor" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [cursor],
          agent: { connectionId: cursor.id, modelId: "custom-cursor-model" },
          scoring: null,
          captcha: {},
        }),
      );
      await setConnectionCredential(root, cursor.id, "cursor-key");
      const value = await computeReadiness(root);
      expect(value.scoreReady).toBe(false);
      expect(value.scoreBlockers.some((b) => b.code === "SCORING_MODEL_MISSING")).toBe(true);
      expect(value.warnings.some((w) => w.code === "MODEL_UNVERIFIED")).toBe(true);
      if (Number(process.versions.node.split(".")[0]) < 24) {
        expect(value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CURSOR_NODE_VERSION")).toBe(true);
      }
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("warns when a cursor key expires within 14 days and blocks when expired", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      const cursor = {
        id: "123e4567-e89b-12d3-a456-426614174021",
        label: "Cursor",
        provider: "cursor" as const,
        expiresAt: soon,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [cursor],
          agent: { connectionId: cursor.id, modelId: "composer-2.5" },
          scoring: null,
          captcha: {},
        }),
      );
      await setConnectionCredential(root, cursor.id, "cursor-key");
      const expiring = await computeReadiness(root);
      expect(expiring.warnings.some((w) => w.code === "CURSOR_LOGIN_EXPIRING")).toBe(true);

      const expired = {
        ...cursor,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [expired],
          agent: { connectionId: cursor.id, modelId: "composer-2.5" },
          scoring: null,
          captcha: {},
        }),
      );
      const blocked = await computeReadiness(root);
      expect(blocked.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CREDENTIAL_EXPIRED")).toBe(
        true,
      );
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("does not block on expired stored Cursor login when CURSOR_API_KEY overrides it", async () => {
    const root = await makeFixtureWorkspace();
    const prior = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "FIXTURE-SECRET-do-not-leak";
    try {
      const cursor = {
        id: "123e4567-e89b-12d3-a456-426614174023",
        label: "Cursor",
        provider: "cursor" as const,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [cursor],
          agent: { connectionId: cursor.id, modelId: "composer-2.5" },
          scoring: null,
          captcha: {},
        }),
      );
      await setConnectionCredential(root, cursor.id, "stored-expired-key");
      const value = await computeReadiness(root);
      expect(
        value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CREDENTIAL_EXPIRED"),
      ).toBe(false);
      expect(value.warnings.some((w) => w.code === "CURSOR_LOGIN_EXPIRING")).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prior;
      await rmFixtureWorkspace(root);
    }
  });

  it("does not warn on a pasted cursor key without expiry metadata", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const cursor = {
        id: "123e4567-e89b-12d3-a456-426614174022",
        label: "Cursor",
        provider: "cursor" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [cursor],
          agent: { connectionId: cursor.id, modelId: "composer-2.5" },
          scoring: null,
          captcha: {},
        }),
      );
      await setConnectionCredential(root, cursor.id, "cursor-key");
      const value = await computeReadiness(root);
      expect(value.warnings.some((w) => w.code === "CURSOR_LOGIN_EXPIRING")).toBe(false);
      expect(value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CREDENTIAL_EXPIRED")).toBe(
        false,
      );
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("reports CREDENTIAL_MISSING on the scoring override when its key is missing", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const agent = {
        id: "123e4567-e89b-12d3-a456-426614174012",
        label: "Agent",
        provider: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:9001/v1",
      };
      const scorer = {
        id: "123e4567-e89b-12d3-a456-426614174013",
        label: "Scorer only",
        provider: "openai" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [agent, scorer],
          agent: { connectionId: agent.id, modelId: "agent-model" },
          scoring: { connectionId: scorer.id, modelId: "gpt-4o-mini" },
          captcha: {},
        }),
      );
      await setConnectionCredential(root, agent.id, "agent-key");
      const value = await computeReadiness(root);
      expect(value.scoreReady).toBe(false);
      expect(value.scoreBlockers.some((b) => b.code === "CREDENTIAL_MISSING" && b.message.includes("Scorer only"))).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("does not block oauth connections that are expired but still refreshable", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const conn = {
        id: "123e4567-e89b-12d3-a456-426614174091",
        label: "Claude",
        provider: "anthropic" as const,
        expiresAt: "2020-01-01T00:00:00.000Z",
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [conn],
          agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
          scoring: null,
          captcha: {},
        }),
      );
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(conn.id)]: {
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-access",
          refresh: "FIXTURE-SECRET-do-not-leak-refresh",
          expires: Date.now() - 60_000,
        },
      }));
      setModelRuntimeFactoryForTests(async () => ({
        getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
      }));
      const value = await computeReadiness(root);
      const connectionStep = value.steps.find((s) => s.id === "connection");
      expect(connectionStep?.blockers.some((b) => b.code === "CREDENTIAL_EXPIRED")).toBe(false);
    } finally {
      setModelRuntimeFactoryForTests(undefined);
      await rmFixtureWorkspace(root);
    }
  });

  it("reports CREDENTIAL_EXPIRED when refreshFailedAt is set on the connection", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const conn = {
        id: "123e4567-e89b-12d3-a456-426614174092",
        label: "Claude",
        provider: "anthropic" as const,
        refreshFailedAt: "2030-01-01T00:00:00.000Z",
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [conn],
          agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
          scoring: null,
          captcha: {},
        }),
      );
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(conn.id)]: {
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-access",
          refresh: "FIXTURE-SECRET-do-not-leak-refresh",
          expires: Date.now() + 60_000,
        },
      }));
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CREDENTIAL_EXPIRED")).toBe(
        true,
      );
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("reports CONFIG_INVALID on the connection step for dual same-provider oauth selections", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const agent = { id: "123e4567-e89b-12d3-a456-426614174093", label: "A", provider: "anthropic" as const };
      const scorer = { id: "123e4567-e89b-12d3-a456-426614174094", label: "B", provider: "anthropic" as const };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [agent, scorer],
          agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
          scoring: { connectionId: scorer.id, modelId: "claude-sonnet-4-5" },
          captcha: {},
        }),
      );
      const oauth = (tag: string) => ({
        type: "oauth" as const,
        access: `FIXTURE-SECRET-do-not-leak-${tag}-a`,
        refresh: `FIXTURE-SECRET-do-not-leak-${tag}-r`,
        expires: Date.now() + 60_000,
      });
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(agent.id)]: oauth("agent"),
        [providerAlias(scorer.id)]: oauth("scorer"),
      }));
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "CONFIG_INVALID")).toBe(
        true,
      );
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("reports MODEL_UNAVAILABLE when Copilot selected models are absent from availableModelIds", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const agent = {
        id: "123e4567-e89b-12d3-a456-426614174095",
        label: "Copilot agent",
        provider: "github-copilot" as const,
      };
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [agent],
          agent: { connectionId: agent.id, modelId: "claude-sonnet-4.6" },
          scoring: { connectionId: agent.id, modelId: "claude-sonnet-4.6" },
          captcha: {},
        }),
      );
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(agent.id)]: {
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-access",
          refresh: "FIXTURE-SECRET-do-not-leak-refresh",
          expires: Date.now() + 60_000,
          availableModelIds: ["claude-sonnet-4-5"],
        },
      }));
      const value = await computeReadiness(root);
      expect(value.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "MODEL_UNAVAILABLE")).toBe(
        true,
      );
      expect(value.scoreBlockers.some((b) => b.code === "MODEL_UNAVAILABLE")).toBe(true);
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(agent.id)]: {
          ...(auth[providerAlias(agent.id)] as Extract<(typeof auth)[string], { type: "oauth" }>),
          availableModelIds: [],
        },
      }));
      const emptyAllowed = await computeReadiness(root);
      expect(
        emptyAllowed.steps.find((s) => s.id === "connection")?.blockers.some((b) => b.code === "MODEL_UNAVAILABLE"),
      ).toBe(true);
      expect(emptyAllowed.scoreBlockers.some((b) => b.code === "MODEL_UNAVAILABLE")).toBe(true);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });
});
