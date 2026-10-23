// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchRail, { searchRouteCounts } from "../chat/SearchRail";
import type { Overview, ReadinessPayload } from "../../shared/types";

function overviewFixture(): Overview {
  return {
    applications: {
      total: 6,
      tracked: 6,
      estimated: 0,
      byApplyState: {
        submitted: 2,
        in_progress: 1,
        paused_for_user: 1,
        blocked: 1,
        queued: 0,
      },
      byPipelineStatus: {},
    },
    queue: 3,
    discovered: 9,
    accounts: 0,
    addresses: 0,
    lastFullGather: null,
    captchaSolver: "off",
    corrupt: [],
  };
}

function readinessFixture(overrides: Partial<Record<string, boolean>> = {}): ReadinessPayload {
  const complete = (id: string) => overrides[id] ?? false;
  const step = (id: "connection" | "profile" | "resume" | "targets", done: boolean) => ({
    id,
    complete: done,
    optional: false,
    blockers: done ? [] : [{ code: `${id}_BLOCK`, message: "Blocked", href: id === "resume" ? "/profile?tab=resumes" : "/" }],
  });
  return {
    steps: [
      step("connection", complete("connection")),
      step("profile", complete("profile")),
      step("resume", complete("resume")),
      step("targets", complete("targets")),
      { id: "readiness", complete: false, optional: false, blockers: [] },
    ],
    browseReady: true,
    discoverReady: complete("targets"),
    applyReady: false,
    scoreReady: false,
    scoreBlockers: [],
    warnings: [],
    captchaOptional: true,
    acknowledgement: { at: null, policy: null, current: "auto-submit-v1" },
    serverRuntime: { nodeMajor: 24 },
  };
}

describe("searchRouteCounts", () => {
  it("maps overview fields to the four route stops", () => {
    expect(searchRouteCounts(overviewFixture())).toEqual({
      found: 9,
      shortlisted: 3,
      applying: 1,
      waiting: 0,
      attention: 2,
      sent: 2,
    });
  });
});

describe("SearchRail", () => {
  afterEach(() => cleanup());

  it("renders the four counts from overview data", () => {
    render(<SearchRail overview={overviewFixture()} readiness={readinessFixture()} onNavigate={() => {}} />);
    expect(screen.getByText("Found").nextElementSibling?.textContent).toBe("9");
    expect(screen.getByText("Shortlisted").nextElementSibling?.textContent).toBe("3");
    expect(screen.getByText("Applying").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Sent").nextElementSibling?.textContent).toBe("2");
  });

  it("shows the empty route sentence when every count is zero", () => {
    render(
      <SearchRail
        overview={{
          applications: { total: 0, tracked: 0, estimated: 0, byApplyState: {}, byPipelineStatus: {} },
          queue: 0,
          discovered: 0,
          accounts: null,
          addresses: null,
          lastFullGather: null,
          captchaSolver: "off",
          corrupt: [],
        }}
        readiness={readinessFixture()}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByRole("button", {name:"Review setup"})).toBeTruthy();
  });

  it("navigates to resumes when Resume is clicked", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<SearchRail overview={overviewFixture()} readiness={readinessFixture()} onNavigate={onNavigate} />);
    await user.click(screen.getByRole("button", { name: /Resume/i }));
    expect(onNavigate).toHaveBeenCalledWith("/profile?tab=resumes");
  });
});
