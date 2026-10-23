// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import ProviderSetup from "../ProviderSetup";
import type { ConnectionList, ConnectionView, DetectedLogin } from "../../shared/providers";

const fetchDetectedLogins = vi.fn();
const adoptLogin = vi.fn();
const startProviderLogin = vi.fn();
const fetchLogin = vi.fn();
const answerLogin = vi.fn();

vi.mock("../settings", () => ({
  createConnection: vi.fn(),
}));

vi.mock("../providerSetupApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providerSetupApi")>();
  return {
    ...actual,
    fetchDetectedLogins: (...args: unknown[]) => fetchDetectedLogins(...args),
    adoptLogin: (...args: unknown[]) => adoptLogin(...args),
    startProviderLogin: (...args: unknown[]) => startProviderLogin(...args),
    fetchLogin: (...args: unknown[]) => fetchLogin(...args),
    answerLogin: (...args: unknown[]) => answerLogin(...args),
  };
});

const OAUTH_PROVIDERS = ["anthropic", "openai-codex", "github-copilot", "cursor"] as const;

function connections(revision = "rev"): ConnectionList {
  return {
    revision,
    data: { connections: [], agent: null, chat: null, scoring: null },
  };
}

function detectedFor(provider: string, action: DetectedLogin["action"] = "adopt"): DetectedLogin {
  return {
    id: `pi-auth:${provider}`,
    kind: "pi-auth",
    provider,
    label: `${provider} detected`,
    expired: false,
    action,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(OAUTH_PROVIDERS)("ProviderSetup (%s)", (provider) => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let popup: { location: { href: string }; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    popup = { location: { href: "" }, close: vi.fn() };
    openSpy = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    fetchDetectedLogins.mockResolvedValue([]);
    adoptLogin.mockResolvedValue({
      connections: [],
      agent: null,
      scoring: null,
      readiness: {} as never,
    });
    startProviderLogin.mockResolvedValue({
      connectionId: "conn-new",
      session: { status: "pending" },
    });
    fetchLogin.mockResolvedValue({ status: "pending" });
    answerLogin.mockResolvedValue({ status: "pending" });
  });

  afterEach(() => {
    cleanup();
    openSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("renders detected rows before sign-in and keeps paste form collapsed", async () => {
    fetchDetectedLogins.mockResolvedValue([detectedFor(provider)]);
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await waitFor(() => expect(screen.getByText(({ anthropic: "Claude Pro/Max", "openai-codex": "ChatGPT (Codex)", "github-copilot": "GitHub Copilot", cursor: "Cursor" })[provider])).toBeTruthy());
    expect(screen.getByRole("button", { name: "Use this" })).toBeTruthy();
    const signInLabel =
      provider === "anthropic"
        ? "Sign in with Claude"
        : provider === "openai-codex"
          ? "Sign in with ChatGPT"
          : provider === "github-copilot"
            ? "Sign in with GitHub Copilot"
            : "Sign in with Cursor";
    expect(screen.queryByRole("button", { name: signInLabel })).toBeNull();
    expect(screen.getByText("Paste a key instead").closest("details")?.open).toBeFalsy();
  });

  it("shows sign-in when provider is not detected", async () => {
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await waitFor(() => expect(fetchDetectedLogins).toHaveBeenCalled());
    const signInLabel =
      provider === "anthropic"
        ? "Sign in with Claude"
        : provider === "openai-codex"
          ? "Sign in with ChatGPT"
          : provider === "github-copilot"
            ? "Sign in with GitHub Copilot"
            : "Sign in with Cursor";
    expect(await screen.findByRole("button", { name: signInLabel })).toBeTruthy();
  });

  it("shows Connected instead of Use this once the detection's origin has a configured connection", async () => {
    fetchDetectedLogins.mockResolvedValue([detectedFor(provider)]);
    const list = connections();
    list.data.connections.push({
      id: "11111111-1111-4111-8111-111111111111",
      label: "adopted",
      provider: provider as ConnectionView["provider"],
      origin: { kind: "pi-auth" },
      credential: { configured: true, source: "app-store" },
      validation: { status: "untested", checkedAt: null },
    } as ConnectionView);
    render(<ProviderSetup connections={list} nodeMajor={24} onUpdated={async () => {}} />);
    await waitFor(() => expect(screen.getByText(({ anthropic: "Claude Pro/Max", "openai-codex": "ChatGPT (Codex)", "github-copilot": "GitHub Copilot", cursor: "Cursor" })[provider])).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("Connected");
    expect(screen.queryByRole("button", { name: "Use this" })).toBeNull();
  });

  it("keeps Use this when the matching connection has no credential yet", async () => {
    fetchDetectedLogins.mockResolvedValue([detectedFor(provider, "sign-in")]);
    const list = connections();
    list.data.connections.push({
      id: "11111111-1111-4111-8111-111111111111",
      label: "reserved",
      provider: provider as ConnectionView["provider"],
      origin: { kind: "pi-auth" },
      credential: { configured: false, source: "none" },
      validation: { status: "untested", checkedAt: null },
    } as ConnectionView);
    render(<ProviderSetup connections={list} nodeMajor={24} onUpdated={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Use this" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("calls adopt exactly once from Use this", async () => {
    fetchDetectedLogins.mockResolvedValue([detectedFor(provider, "adopt-scoring")]);
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: "Use for scoring" }));
    expect(adoptLogin).toHaveBeenCalledTimes(1);
    expect(adoptLogin).toHaveBeenCalledWith(`pi-auth:${provider}`);
  });

  it("starts provider login with detectionId for sign-in detections", async () => {
    fetchDetectedLogins.mockResolvedValue([detectedFor(provider, "sign-in")]);
    const pending = deferred<Awaited<ReturnType<typeof startProviderLogin>>>();
    startProviderLogin.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: "Use this" }));
    expect(startProviderLogin).toHaveBeenCalledWith(
      expect.objectContaining({ provider, detectionId: `pi-auth:${provider}` }),
    );
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    pending.resolve({ connectionId: "conn-new", session: { status: "pending" } });
    await screen.findByText(/Sign-in status: pending/);
  });

  it("navigates popup when authUrl or device verification arrives", async () => {
    const user = userEvent.setup();
    if (provider === "github-copilot") {
      startProviderLogin.mockResolvedValueOnce({
        connectionId: "conn-copilot",
        session: {
          status: "pending",
          deviceCode: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "" },
        },
      });
    } else {
      startProviderLogin.mockResolvedValueOnce({
        connectionId: "conn-oauth",
        session: { status: "pending", authUrl: "https://example.com/oauth" },
      });
    }
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    const signInLabel =
      provider === "anthropic"
        ? "Sign in with Claude"
        : provider === "openai-codex"
          ? "Sign in with ChatGPT"
          : provider === "github-copilot"
            ? "Sign in with GitHub Copilot"
            : "Sign in with Cursor";
    await user.click(await screen.findByRole("button", { name: signInLabel }));
    if (provider === "github-copilot") {
      expect(popup.location.href).toBe("https://github.com/login/device");
      expect(screen.getByText(/ABCD-1234/)).toBeTruthy();
    } else {
      expect(popup.location.href).toBe("https://example.com/oauth");
    }
  });

  it("polls the returned connection id when the initial session has no navigation target", async () => {
    fetchLogin.mockResolvedValueOnce({
      status: "pending",
      authUrl: "https://example.com/oauth-from-poll",
    });
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    const signInLabel =
      provider === "anthropic"
        ? "Sign in with Claude"
        : provider === "openai-codex"
          ? "Sign in with ChatGPT"
          : provider === "github-copilot"
            ? "Sign in with GitHub Copilot"
            : "Sign in with Cursor";
    fireEvent.click(await screen.findByRole("button", { name: signInLabel }));
    await waitFor(() => expect(fetchLogin).toHaveBeenCalledWith("conn-new"), { timeout: 2_500 });
    await waitFor(() => expect(popup.location.href).toBe("https://example.com/oauth-from-poll"));
  });

  it("does not let a delayed pending poll overwrite a newer terminal response", async () => {
    if (provider !== "anthropic") return;
    let resolveFirst!: (session: { status: "pending" }) => void;
    const first = new Promise<{ status: "pending" }>((resolve) => {
      resolveFirst = resolve;
    });
    fetchLogin.mockImplementationOnce(() => first).mockResolvedValueOnce({ status: "succeeded" });
    const onUpdated = vi.fn();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Claude" }));
    await waitFor(() => expect(fetchLogin).toHaveBeenCalledTimes(2), { timeout: 3_500 });
    await waitFor(() => expect(screen.getByText("Sign-in status: succeeded")).toBeTruthy());
    resolveFirst({ status: "pending" });
    await waitFor(() => expect(screen.getByText("Sign-in status: succeeded")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it("shows Open sign-in page when popup open returns null", async () => {
    openSpy.mockReturnValue(null);
    startProviderLogin.mockResolvedValueOnce({
      connectionId: "conn-blocked",
      session: { status: "pending", authUrl: "https://example.com/blocked" },
    });
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    const signInLabel =
      provider === "anthropic"
        ? "Sign in with Claude"
        : provider === "openai-codex"
          ? "Sign in with ChatGPT"
          : provider === "github-copilot"
            ? "Sign in with GitHub Copilot"
            : "Sign in with Cursor";
    await user.click(await screen.findByRole("button", { name: signInLabel }));
    expect(screen.getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(
      "https://example.com/blocked",
    );
  });
});

describe("ProviderSetup prompts", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(window, "open").mockReturnValue({ location: { href: "" }, close: vi.fn() } as unknown as Window);
    fetchDetectedLogins.mockResolvedValue([]);
    startProviderLogin.mockResolvedValue({ connectionId: "c1", session: { status: "pending" } });
    answerLogin.mockReset();
    answerLogin.mockResolvedValue({ status: "pending" });
  });

  it("submits manual_code and text prompt answers through the DOM", async () => {
    const cases = [
      { type: "manual_code", message: "Paste code", button: "Submit code", value: "manual-value" },
      { type: "text", message: "Enter value", button: "Submit", value: "text-value" },
    ] as const;
    for (const c of cases) {
      answerLogin.mockClear();
      startProviderLogin.mockResolvedValueOnce({
        connectionId: "c-prompt",
        session: {
          status: "pending",
          prompt: { id: "p1", type: c.type, message: c.message },
        },
      });
      const user = userEvent.setup();
      const { unmount } = render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
      await user.click(await screen.findByRole("button", { name: "Sign in with Claude" }));
      await user.type(screen.getByLabelText(c.message), c.value);
      await user.click(screen.getByRole("button", { name: c.button }));
      expect(answerLogin).toHaveBeenCalledWith("c-prompt", "p1", c.value);
      unmount();
    }
  });

  it("submits the exact selected prompt option", async () => {
    startProviderLogin.mockResolvedValueOnce({
      connectionId: "c-select",
      session: {
        status: "pending",
        prompt: {
          id: "select-1",
          type: "select",
          message: "Choose a method",
          options: [
            { id: "manual", label: "Manual" },
            { id: "device", label: "Device code" },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: "Sign in with Claude" }));
    await user.click(screen.getByRole("button", { name: "Device code" }));
    expect(answerLogin).toHaveBeenCalledWith("c-select", "select-1", "device");
  });

  it("renders device codes without answering a prompt", async () => {
    startProviderLogin.mockResolvedValueOnce({
      connectionId: "c-device",
      session: {
        status: "pending",
        deviceCode: { userCode: "WXYZ-9999", verificationUri: "https://device.example", expiresAt: "" },
      },
    });
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await user.click(await screen.findByRole("button", { name: "Sign in with GitHub Copilot" }));
    expect(screen.getByText(/WXYZ-9999/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(answerLogin).not.toHaveBeenCalled();
  });

  it("paste form lists only apiKey providers", async () => {
    fetchDetectedLogins.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<ProviderSetup connections={connections()} nodeMajor={24} onUpdated={async () => {}} />);
    await user.click(screen.getByText("Paste a key instead"));
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    const ids = Array.from(select.options).map((o) => o.value);
    expect(ids).toContain("openai");
    expect(ids).not.toContain("openai-codex");
  });
});
