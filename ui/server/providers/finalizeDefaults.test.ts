import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modifyAuthFile } from "./authStoreFile";
import { finalizeDefaults } from "./finalizeDefaults";
import { providerAlias } from "./providerIds";
import { defaultModels } from "../../shared/defaultModels";
import { JEV_TYPESAFE_MODEL_ID } from "../../shared/jevModels";
import { isolatedMetadataRuntime } from "./metadataRuntime";
import { readApplicationSettings } from "../applicationConfigStore";

describe("finalizeDefaults", () => {
  it("rejects a credential transition that makes selected same-provider connections both OAuth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rolebound-finalize-"));
    const agentId = "123e4567-e89b-12d3-a456-426614174090";
    const scoringId = "123e4567-e89b-12d3-a456-426614174091";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [
          { id: agentId, label: "Agent", provider: "anthropic" },
          { id: scoringId, label: "Scorer", provider: "anthropic" },
        ],
        agent: { connectionId: agentId, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scoringId, modelId: "claude-haiku-4-5" },
        captcha: { provider: "off", api_key: "" },
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(agentId)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-agent",
        refresh: "FIXTURE-SECRET-do-not-leak-agent-refresh",
        expires: Date.now() + 60_000,
      },
      [providerAlias(scoringId)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-scoring",
        refresh: "FIXTURE-SECRET-do-not-leak-scoring-refresh",
        expires: Date.now() + 60_000,
      },
    }));

    await expect(finalizeDefaults(root, scoringId)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      status: 422,
    });
  });

  it("finalizes Copilot with a model allowed by the stored credential", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rolebound-finalize-copilot-"));
    const id = "123e4567-e89b-12d3-a456-426614174092";
    const runtime = await isolatedMetadataRuntime();
    const allowed = runtime
      .getModels("github-copilot")
      .map((model) => model.id)
      .find((modelId) => modelId !== defaultModels.agent["github-copilot"]);
    expect(allowed).toBeTruthy();
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [{ id, label: "Copilot", provider: "github-copilot" }],
        agent: null,
        scoring: null,
        captcha: { provider: "off", api_key: "" },
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(id)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-copilot",
        refresh: "FIXTURE-SECRET-do-not-leak-copilot-refresh",
        expires: Date.now() + 60_000,
        availableModelIds: [allowed!],
      },
    }));

    await finalizeDefaults(root, id);

    expect((await readApplicationSettings(root)).data.agent?.modelId).toBe(allowed);
  });

  it("uses an already configured Jev connection when an agent login is finalized", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rolebound-finalize-existing-jev-"));
    const cursorId = "123e4567-e89b-12d3-a456-426614174093";
    const typesafeId = "123e4567-e89b-12d3-a456-426614174094";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [
          { id: cursorId, label: "Cursor", provider: "cursor" },
          { id: typesafeId, label: "TypeSafe", provider: "typesafe" },
        ],
        agent: null,
        scoring: null,
        captcha: { provider: "off", api_key: "" },
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(cursorId)]: {
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-cursor",
      },
      [providerAlias(typesafeId)]: {
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-typesafe",
      },
    }));

    await finalizeDefaults(root, cursorId);

    expect((await readApplicationSettings(root)).data.scoring).toEqual({
      connectionId: typesafeId,
      modelId: JEV_TYPESAFE_MODEL_ID,
    });
  });
});
