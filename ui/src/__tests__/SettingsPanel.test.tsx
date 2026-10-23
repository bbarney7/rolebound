// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Settings from "../SettingsPanel";

const fetchConnections = vi.fn();
const fetchReadiness = vi.fn();
const fetchCaptchaSettings = vi.fn();
const testModelConnection = vi.fn();
const deleteModelConnection = vi.fn();
const updateSelections = vi.fn();
const fetchDetectedLogins = vi.fn();

vi.mock("../settings", () => ({
  fetchConnections: (...args: unknown[]) => fetchConnections(...args),
  fetchReadiness: (...args: unknown[]) => fetchReadiness(...args),
  fetchCaptchaSettings: (...args: unknown[]) => fetchCaptchaSettings(...args),
  testModelConnection: (...args: unknown[]) => testModelConnection(...args),
  deleteModelConnection: (...args: unknown[]) => deleteModelConnection(...args),
  updateSelections: (...args: unknown[]) => updateSelections(...args),
  fetchModelCatalog: vi.fn().mockResolvedValue([]),
  createConnection: vi.fn(),
  updateCaptchaSettings: vi.fn(),
  testCaptchaKey: vi.fn(),
  hcaptchaNote: () => null,
  keyStatusLine: () => "",
}));

vi.mock("../providerSetupApi", () => ({
  fetchDetectedLogins: (...args: unknown[]) => fetchDetectedLogins(...args),
  adoptLogin: vi.fn(),
  startProviderLogin: vi.fn(),
  startLogin: vi.fn(),
  fetchLogin: vi.fn(),
  answerLogin: vi.fn(),
  cancelLogin: vi.fn(),
}));

vi.mock("../ApplicationsSettingsSection", () => ({
  ApplicationsSettingsSection: () => null,
}));

describe("SettingsPanel regression", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    fetchDetectedLogins.mockResolvedValue([]);
    fetchCaptchaSettings.mockResolvedValue({
      provider: "off",
      maxPaidTasksPerDay: 20,
      hasApiKey: false,
      keyHint: null,
      keySource: "none",
      fileHasKey: false,
      warnings: [],
      providers: [],
      dailyPaidTasksCount: 0,
    });
    fetchReadiness.mockResolvedValue({
      serverRuntime: { nodeMajor: 24 },
      acknowledgement: null,
      steps: [],
      warnings: [],
    });
    fetchConnections.mockResolvedValue({
      revision: "rev-1",
      data: {
        connections: [
          {
            id: "cursor-1",
            label: "Cursor",
            provider: "cursor",
            credential: { configured: true, source: "app-store" },
            validation: { status: "valid", checkedAt: null },
            email: "dev@example.com",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        ],
        agent: { connectionId: "cursor-1", modelId: "composer-2.5" },
        chat: null,
        scoring: null,
      },
    });
    testModelConnection.mockResolvedValue({ ok: true, models: [{ id: "composer-2.5" }] });
    deleteModelConnection.mockResolvedValue(undefined);
    updateSelections.mockResolvedValue(undefined);
  });

  it("connection Test and Remove call their endpoints", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cursor" })).toBeTruthy());
    await user.click(screen.getByText(/Manage accounts/));
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(testModelConnection).toHaveBeenCalledWith("cursor-1");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(deleteModelConnection).toHaveBeenCalledWith("cursor-1", "rev-1");
  });

  it("renders the Cursor signed-in status line", async () => {
    render(<Settings />);
    expect(await screen.findByText(/Signed in as dev@example.com/)).toBeTruthy();
  });

  it("saves model selection through ConnectionSelections", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => expect(screen.getByLabelText(/Applying model/i)).toBeTruthy());
    await user.click(screen.getByRole("button", {name:"Change"}));
    await user.clear(screen.getByLabelText(/Applying model/i));
    await user.type(screen.getByLabelText(/Applying model/i), "custom-model");
    await user.click(screen.getByRole("option",{name:/Use custom model ID/}));
    await user.click(screen.getByRole("button", { name: /Save model selection/i }));
    expect(updateSelections).toHaveBeenCalled();
  });
});

describe("account operation feedback", () => {
  afterEach(cleanup);
  it("blocks repeat tests and keeps a failed result beside its account",async () => {
    let finish!: (value: {ok:boolean;code:string}) => void;
    testModelConnection.mockReset();
    testModelConnection.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fetchDetectedLogins.mockResolvedValue([]);
    const user = userEvent.setup(); render(<Settings />);
    await user.click(await screen.findByText(/Manage accounts/));
    await user.click(screen.getByRole("button",{name:"Test connection"}));
    expect((screen.getByRole("button",{name:"Testing…"}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button",{name:"Remove"}) as HTMLButtonElement).disabled).toBe(true);
    finish({ok:false,code:"provider_unavailable"});
    expect(await screen.findByRole("alert")).toHaveProperty("textContent","Connection test failed: provider_unavailable");
    expect(testModelConnection).toHaveBeenCalledTimes(1);
  });
});
