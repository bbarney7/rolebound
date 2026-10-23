import { describe, expect, it } from "vitest";
import { planChatModelSwitch } from "../chat/chatModelSwitch";
import type { ConnectionList } from "../../shared/providers";
import type { RunSummary } from "../../shared/types";

function list(chat: ConnectionList["data"]["chat"]): ConnectionList {
  return {
    revision: "rev",
    data: {
      connections: [],
      agent: { connectionId: "a", modelId: "agent-model" },
      chat,
      scoring: null,
    },
  };
}

const chatRun: RunSummary = {
  runId: "run-chat-1",
  kind: "chat",
  slug: null,
  sessionName: "ui:chat",
  model: "agent-model",
  status: "waiting",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  pid: 1,
  firstSeq: 1,
  lastSeq: 1,
};

describe("planChatModelSwitch", () => {
  it("plans continueFrom when the chat model changes during a waiting chat", () => {
    const prev = list(null);
    const next = list({ connectionId: "b", modelId: "other" });
    const plan = planChatModelSwitch(prev, next, chatRun, [{ kind: "user", key: "u1", text: "hi" }], []);
    expect(plan.continueFrom).toBe("run-chat-1");
    expect(plan.finishFirst).toBe(true);
    expect(plan.note).toMatch(/Switched chat to other/);
  });

  it("does not plan a fork when the model is unchanged", () => {
    const prev = list(null);
    const plan = planChatModelSwitch(prev, prev, chatRun, [{ kind: "user", key: "u1", text: "hi" }], []);
    expect(plan.continueFrom).toBeNull();
  });
});
