// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelMenu from "../chat/ModelMenu";
import type { ConnectionList } from "../../shared/providers";

const updateSelections = vi.fn();
const fetchModelCatalog = vi.fn();

vi.mock("../settings", () => ({
  updateSelections: (...args: unknown[]) => updateSelections(...args),
  fetchModelCatalog: (...args: unknown[]) => fetchModelCatalog(...args),
}));

function connections(overrides: Partial<ConnectionList["data"]> = {}): ConnectionList {
  return {
    revision: "rev-1",
    data: {
      connections: [
        {
          id: "agent-1",
          label: "OpenAI",
          provider: "openai",
          credential: { configured: true, source: "app-store" },
          validation: { status: "untested", checkedAt: null },
        },
        {
          id: "chat-1",
          label: "Anthropic",
          provider: "anthropic",
          credential: { configured: true, source: "app-store" },
          validation: { status: "untested", checkedAt: null },
        },
      ],
      agent: { connectionId: "agent-1", modelId: "gpt-5-chat-latest", thinking: "medium" },
      chat: null,
      scoring: null,
      ...overrides,
    },
  };
}

describe("ModelMenu", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    updateSelections.mockReset();
    fetchModelCatalog.mockReset();
    fetchModelCatalog.mockResolvedValue([{ id: "gpt-5-chat-latest" }]);
  });

  it("renders current model and opens the dialog", async () => {
    const user = userEvent.setup();
    render(
      <ModelMenu
        connections={connections()}
        run={null}
        onConnectionsChange={async () => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Model: gpt-5-chat-latest/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Model: gpt-5-chat-latest/i }));
    expect(screen.getByRole("dialog", { name: "Chat model" })).toBeTruthy();
  });

  it("saving calls updateSelections with chat set", async () => {
    const user = userEvent.setup();
    updateSelections.mockResolvedValue(
      connections({ chat: { connectionId: "chat-1", modelId: "claude-sonnet" } }),
    );
    const onConnectionsChange = vi.fn();
    render(
      <ModelMenu connections={connections()} run={null} onConnectionsChange={onConnectionsChange} />,
    );
    await user.click(screen.getByRole("button", { name: /Model: gpt-5-chat-latest/i }));
    await user.selectOptions(screen.getByLabelText(/Chat connection/i), "chat-1");
    const chatModelInput = document.getElementById("rb-chat-model-id") as HTMLInputElement;
    await user.clear(chatModelInput);
    await user.type(chatModelInput, "claude-sonnet");
    await user.click(screen.getByRole("button", { name: /^Use$/i }));
    await waitFor(() => expect(updateSelections).toHaveBeenCalled());
    expect(updateSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: { connectionId: "chat-1", modelId: "claude-sonnet" },
        expectedRevision: "rev-1",
      }),
    );
    expect(onConnectionsChange).toHaveBeenCalled();
  });

  it("is disabled while the run is starting", () => {
    render(
      <ModelMenu
        connections={connections()}
        run={{
          runId: "r1",
          kind: "chat",
          slug: null,
          sessionName: "ui:chat",
          model: "gpt",
          status: "starting",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          pid: 1,
          firstSeq: 1,
          lastSeq: 1,
        }}
        onConnectionsChange={async () => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: /Model: gpt-5-chat-latest/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Wait for the reply to finish");
  });
});
