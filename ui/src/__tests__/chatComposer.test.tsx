// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPane from "../chat/ChatPane";
import Composer from "../chat/Composer";
import type { RunSummary } from "../../shared/types";

const runningRun: RunSummary = {
  runId: "r1",
  kind: "chat",
  slug: null,
  sessionName: "ui:chat",
  model: "test",
  status: "running",
  startedAt: new Date().toISOString(),
  endedAt: null,
  pid: 1,
  firstSeq: 1,
  lastSeq: 1,
};

const idleRun: RunSummary = { ...runningRun, status: "waiting" };

describe("Composer", () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const onInterrupt = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    onSend.mockClear();
    onInterrupt.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends trimmed text on Enter and not on Shift+Enter", async () => {
    const user = userEvent.setup();
    render(
      <Composer
        run={idleRun}
        placeholder="Type"
        chips={[]}
        canSend
        error={null}
        onSend={onSend}
        onInterrupt={onInterrupt}
      />,
    );
    const field = screen.getByLabelText("Message Rolebound");
    await user.type(field, "  hello  ");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
    onSend.mockClear();
    await user.type(field, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(field, "line2");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("line1\nline2");
  });

  it("appends attached file path to the outgoing message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === "/api/session"
        ? { ok: true, status: 200, json: async () => ({ csrfToken: "test-token" }) }
        : { ok: true, status: 201, json: async () => ({ path: "uploads/x.pdf" }) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <Composer
        run={idleRun}
        placeholder="Type"
        chips={[]}
        canSend
        error={null}
        onSend={onSend}
        onInterrupt={onInterrupt}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["%PDF-1.4"], "x.pdf", { type: "application/pdf" });
    await user.upload(input, file);
    await waitFor(() => expect(screen.getByText("x.pdf")).toBeTruthy());
    await user.click(screen.getByLabelText("Send"));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Attached file: uploads/x.pdf"),
    );
    const upload = fetchMock.mock.calls.find(([input]) => String(input) === "/api/chat/attachments");
    expect(new Headers((upload?.[1] as RequestInit | undefined)?.headers).get("X-Pi-Jobs-CSRF")).toBe("test-token");
  });
});

describe("Composer send lifecycle", () => {
  afterEach(() => cleanup());

  const renderComposer = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    render(
      <Composer
        run={idleRun}
        placeholder="Type"
        chips={["Find new roles"]}
        canSend
        error={null}
        onSend={vi.fn().mockResolvedValue(true)}
        onInterrupt={vi.fn().mockResolvedValue(undefined)}
        {...props}
      />,
    );

  it("keeps the draft when the server refuses the message and clears it when accepted", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderComposer({ onSend });
    const field = screen.getByLabelText("Message Rolebound") as HTMLTextAreaElement;
    await user.type(field, "hello{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(field.value).toBe("hello");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("holds sends and chips while the run is still starting", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(true);
    renderComposer({ run: { ...idleRun, status: "starting" }, onSend });
    await user.type(screen.getByLabelText("Message Rolebound"), "hello{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Find new roles" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers End session only while the run is waiting", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderComposer({ onFinish });
    await user.click(screen.getByRole("button", { name: "End session" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    rerender(
      <Composer
        run={runningRun}
        placeholder="Type"
        chips={[]}
        canSend
        error={null}
        onSend={vi.fn().mockResolvedValue(true)}
        onInterrupt={vi.fn().mockResolvedValue(undefined)}
        onFinish={onFinish}
      />,
    );
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
  });
});

describe("ChatPane Esc", () => {
  it("calls onInterrupt on Esc only while running", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    const onRespondUi = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ChatPane
        run={runningRun}
        entries={[]}
        busy={false}
        error={null}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onRespondUi={onRespondUi}
        onFinish={async () => {}}
        chips={[]}
        placeholder="Hi"
        canSend
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    onInterrupt.mockClear();
    rerender(
      <ChatPane
        run={idleRun}
        entries={[]}
        busy={false}
        error={null}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onRespondUi={onRespondUi}
        onFinish={async () => {}}
        chips={[]}
        placeholder="Hi"
        canSend
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
