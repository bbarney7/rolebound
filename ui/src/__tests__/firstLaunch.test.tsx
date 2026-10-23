// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FirstLaunch from "../chat/FirstLaunch";
import type { ConnectionList } from "../../shared/providers";
import type { ReadinessPayload } from "../../shared/types";

const fetchConnections = vi.fn();
const fetchReadiness = vi.fn();
const fetchDetectedLogins = vi.fn();

vi.mock("../settings", () => ({
  fetchConnections: (...args: unknown[]) => fetchConnections(...args),
  fetchReadiness: (...args: unknown[]) => fetchReadiness(...args),
}));

vi.mock("../providerSetupApi", () => ({
  fetchDetectedLogins: (...args: unknown[]) => fetchDetectedLogins(...args),
  adoptLogin: vi.fn(),
}));

function connections(): ConnectionList {
  return { revision: "r1", data: { connections: [], agent: null, chat: null, scoring: null } };
}

function readiness(connectionComplete: boolean): ReadinessPayload {
  return {
    steps: [
      {
        id: "connection",
        complete: connectionComplete,
        optional: false,
        blockers: connectionComplete ? [] : [{ code: "CREDENTIAL_MISSING", message: "Not connected", href: "/settings" }],
      },
      { id: "profile", complete: false, optional: false, blockers: [] },
      { id: "resume", complete: false, optional: false, blockers: [] },
      { id: "targets", complete: false, optional: false, blockers: [] },
      { id: "readiness", complete: false, optional: false, blockers: [] },
    ],
    browseReady: true,
    discoverReady: false,
    applyReady: false,
    scoreReady: false,
    scoreBlockers: [],
    warnings: [],
    captchaOptional: true,
    acknowledgement: { at: null, policy: null, current: "auto-submit-v1" },
    serverRuntime: { nodeMajor: 24 },
  };
}

describe("FirstLaunch", () => {
  beforeEach(() => {
    fetchDetectedLogins.mockResolvedValue([]);
    fetchConnections.mockResolvedValue(connections());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders ProviderSetup inside the card when no model is connected", async () => {
    fetchReadiness.mockResolvedValue(readiness(false));
    render(
      <FirstLaunch connectionReady={false} onReadinessChange={() => {}} onConnectionsChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Connect an AI model")).toBeTruthy());
    expect(screen.getByText("Paste a key instead")).toBeTruthy();
    expect(screen.getByText(/Connect an AI account to get started/i)).toBeTruthy();
  });

  it("renders the connected copy without the setup card when a model is connected", async () => {
    fetchReadiness.mockResolvedValue(readiness(true));
    render(
      <FirstLaunch connectionReady={true} onReadinessChange={() => {}} onConnectionsChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/drop in your resume/i)).toBeTruthy());
    expect(screen.queryByText("Connect an AI model")).toBeNull();
    expect(screen.queryByText("Paste a key instead")).toBeNull();
  });
});
