// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import ConnectionSelections from "../ConnectionSelections";
import type { ConnectionList } from "../../shared/providers";

const updateSelections = vi.fn();
const fetchModelCatalog = vi.fn();

vi.mock("../settings", () => ({
  updateSelections: (...args: unknown[]) => updateSelections(...args),
  fetchModelCatalog: (...args: unknown[]) => fetchModelCatalog(...args),
}));

function list(overrides: Partial<ConnectionList["data"]> = {}, revision = "rev-1"): ConnectionList {
  return {
    revision,
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
          id: "typesafe-1",
          label: "TypeSafe",
          provider: "typesafe",
          credential: { configured: true, source: "app-store" },
          validation: { status: "untested", checkedAt: null },
        },
      ],
      agent: { connectionId: "agent-1", modelId: "gpt-5-chat-latest" },
      chat: null,
      scoring: null,
      ...overrides,
    },
  };
}

describe("ConnectionSelections", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    updateSelections.mockReset();
    fetchModelCatalog.mockReset();
    fetchModelCatalog.mockResolvedValue([{ id: "jev-latest", label: "Jev" }]);
  });

  it("auto-fills jev-latest for TypeSafe and sends it on save", async () => {
    const user = userEvent.setup();
    render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "typesafe-1");
    const scoreModel = screen.getByLabelText(/Scoring model/i) as HTMLInputElement;
    await waitFor(() => expect(scoreModel.value).toBe("jev-latest"));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(updateSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        scoring: { connectionId: "typesafe-1", modelId: "jev-latest" },
      }),
    );
  });

  it("auto-fills a singleton catalog after changing to a provider without an explicit default", async () => {
    const user = userEvent.setup();
    const current = list();
    render(
      <ConnectionSelections
        value={list({
          connections: [
            ...current.data.connections,
            {
              id: "local-1",
              label: "Local scorer",
              provider: "openai-compatible",
              baseUrl: "http://127.0.0.1:8080",
              credential: { configured: false, source: "none" },
              validation: { status: "untested", checkedAt: null },
            },
          ],
        })}
        onSaved={async () => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "local-1");

    await waitFor(() =>
      expect((screen.getByLabelText(/Scoring model/i) as HTMLInputElement).value).toBe("jev-latest"),
    );
  });

  it("ignores a stale singleton catalog response after the scoring connection changes again", async () => {
    let resolveFirst!: (models: Array<{ id: string }>) => void;
    let resolveSecond!: (models: Array<{ id: string }>) => void;
    const first = new Promise<Array<{ id: string }>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Array<{ id: string }>>((resolve) => {
      resolveSecond = resolve;
    });
    fetchModelCatalog.mockImplementation((id: string) =>
      id === "local-1" ? first : id === "local-2" ? second : Promise.resolve([]),
    );
    const current = list();
    const local = (id: string) => ({
      id,
      label: id,
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8080",
      credential: { configured: false, source: "none" as const },
      validation: { status: "untested" as const, checkedAt: null },
    });
    const user = userEvent.setup();
    render(
      <ConnectionSelections
        value={list({ connections: [...current.data.connections, local("local-1"), local("local-2")] })}
        onSaved={async () => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "local-1");
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "local-2");
    resolveSecond([{ id: "second-model" }]);
    await waitFor(() =>
      expect((screen.getByLabelText(/Scoring model/i) as HTMLInputElement).value).toBe("second-model"),
    );
    await act(async () => {
      resolveFirst([{ id: "stale-first-model" }]);
      await first;
    });
    expect((screen.getByLabelText(/Scoring model/i) as HTMLInputElement).value).toBe("second-model");
  });

  it("clears score model when switching away from scoring connection", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionSelections
        value={list({ scoring: { connectionId: "typesafe-1", modelId: "jev-latest" } })}
        onSaved={async () => {}}
      />,
    );
    const scoreModel = screen.getByLabelText(/Scoring model/i) as HTMLInputElement;
    expect(scoreModel.value).toBe("jev-latest");
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "");
    await waitFor(() => expect(screen.queryByLabelText(/Scoring model/i)).toBeNull());
  });

  it("shows server error without wiping user edits", async () => {
    const user = userEvent.setup();
    updateSelections.mockRejectedValueOnce(new Error("TypeSafe connections only support the Jev scoring model"));
    render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "typesafe-1");
    const scoreModel = screen.getByLabelText(/Scoring model/i) as HTMLInputElement;
    await user.clear(scoreModel);
    await user.type(scoreModel, "wrong-model");
    await user.click(screen.getByRole("option", {name:/Use custom model ID/}));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(await screen.findByText(/Jev scoring model/i)).toBeTruthy();
    expect(scoreModel.value).toBe("wrong-model");
  });

  it("keeps dirty scoring edits when parent passes a fresh value object", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "typesafe-1");
    const scoreModel = screen.getByLabelText(/Scoring model/i) as HTMLInputElement;
    await user.clear(scoreModel);
    await user.type(scoreModel, "custom-score");
    await user.click(screen.getByRole("option", {name:/Use custom model ID/}));
    rerender(<ConnectionSelections value={{ ...list(), revision: "rev-2" }} onSaved={async () => {}} />);
    expect(scoreModel.value).toBe("custom-score");
  });

  it("keeps the connection-driven TypeSafe model when the parent rerenders immediately", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.selectOptions(screen.getByLabelText(/Scoring connection/i), "typesafe-1");
    const scoreModel = screen.getByLabelText(/Scoring model/i) as HTMLInputElement;
    await waitFor(() => expect(scoreModel.value).toBe("jev-latest"));

    rerender(<ConnectionSelections value={{ ...list(), revision: "rev-2" }} onSaved={async () => {}} />);

    expect((screen.getByLabelText(/Scoring connection/i) as HTMLSelectElement).value).toBe("typesafe-1");
    expect(scoreModel.value).toBe("jev-latest");
  });

  it("resets dirty baseline after a successful save so the next value applies", async () => {
    const user = userEvent.setup();
    updateSelections.mockResolvedValue(undefined);
    const { rerender } = render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.clear(screen.getByLabelText(/Applying model/i));
    await user.type(screen.getByLabelText(/Applying model/i), "custom-agent");
    await user.click(screen.getByRole("option", {name:/Use custom model ID/}));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    rerender(
      <ConnectionSelections
        value={list({ agent: { connectionId: "agent-1", modelId: "server-model" } }, "rev-3")}
        onSaved={async () => {}}
      />,
    );
    expect((screen.getByLabelText(/Applying model/i) as HTMLInputElement).value).toBe("server-model");
  });

  it('saves chat: null when "Same as applying model" is selected', async () => {
    const user = userEvent.setup();
    updateSelections.mockResolvedValue(undefined);
    render(
      <ConnectionSelections
        value={list({ chat: { connectionId: "agent-1", modelId: "other-chat" } })}
        onSaved={async () => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/Chat connection/i), "");
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(updateSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: null,
      }),
    );
  });

  it("saves an explicit chat connection and model", async () => {
    const user = userEvent.setup();
    updateSelections.mockResolvedValue(undefined);
    render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.selectOptions(screen.getByLabelText(/Chat connection/i), "agent-1");
    await user.clear(screen.getByLabelText(/Chat model/i));
    await user.type(screen.getByLabelText(/Chat model/i), "chat-only-model");
    await user.click(screen.getByRole("option",{name:/Use custom model ID/}));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(updateSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: { connectionId: "agent-1", modelId: "chat-only-model" },
      }),
    );
  });

  it("still saves agent selection", async () => {
    const user = userEvent.setup();
    updateSelections.mockResolvedValue(undefined);
    render(<ConnectionSelections value={list()} onSaved={async () => {}} />);
    await user.clear(screen.getByLabelText(/Applying model/i));
    await user.type(screen.getByLabelText(/Applying model/i), "new-agent-model");
    await user.click(screen.getByRole("option", {name:/Use custom model ID/}));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(updateSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ modelId: "new-agent-model" }),
        expectedRevision: "rev-1",
      }),
    );
  });
});
