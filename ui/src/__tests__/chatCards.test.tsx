// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolCardDetails } from "../../shared/types";
import JobListCard from "../chat/cards/JobListCard";
import ProfileDiffCard from "../chat/cards/ProfileDiffCard";
import RunProgressCard from "../chat/cards/RunProgressCard";
import ApplicationCard from "../chat/cards/ApplicationCard";
import ConnectionCard from "../chat/cards/ConnectionCard";
import ToolCard from "../chat/cards/ToolCard";

const onSend = vi.fn();

function renderCard(details: ToolCardDetails) {
  return render(<ToolCard details={details} onSend={onSend} />);
}

describe("tool cards", () => {
  it("job-list renders valid details and survives garbage", () => {
    expect(() =>
      render(
        <JobListCard
          details={{
            card: "job-list",
            jobs: [{ company: "Ramp", title: "Engineer", location: "Remote", url: "https://example.com", score: 5 }],
          }}
          onSend={onSend}
        />,
      ),
    ).not.toThrow();
    expect(() =>
      render(<JobListCard details={{ card: "job-list", jobs: "nope" } as ToolCardDetails} onSend={onSend} />),
    ).not.toThrow();
    expect(() => renderCard({ card: "job-list", jobs: "nope" } as ToolCardDetails)).not.toThrow();
  });

  it("profile-diff renders valid and invalid details", () => {
    expect(() =>
      render(
        <ProfileDiffCard
          details={{ card: "profile-diff", section: "Identity", before: "old", after: "**new**" }}
        />,
      ),
    ).not.toThrow();
    expect(() =>
      render(<ProfileDiffCard details={{ card: "profile-diff", sections: ["identity", "resume"] }} />),
    ).not.toThrow();
    expect(() => renderCard({ card: "profile-diff", section: 1 } as ToolCardDetails)).not.toThrow();
  });

  it("run-progress renders valid and invalid details", () => {
    expect(() =>
      render(<RunProgressCard details={{ card: "run-progress", path: "resumes/default.pdf", text: "hello world", setDefault: true }} />),
    ).not.toThrow();
    expect(() => renderCard({ card: "run-progress" })).not.toThrow();
  });

  it("application renders valid and invalid details", () => {
    expect(() =>
      render(
        <ApplicationCard
          details={{ card: "application", company: "Ramp", title: "Engineer", applyState: "submitted", slug: "ramp-eng" }}
        />,
      ),
    ).not.toThrow();
    expect(() => renderCard({ card: "application", company: null } as ToolCardDetails)).not.toThrow();
  });

  it("connection renders valid and invalid details", () => {
    expect(() =>
      render(<ConnectionCard details={{ card: "connection", provider: "Cursor", status: "Connected" }} />),
    ).not.toThrow();
    expect(() => renderCard({ card: "connection", provider: 9 } as ToolCardDetails)).not.toThrow();
  });
});
