// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileResumes from "../ProfileResumes";
import type { ProfileResumeView, ResumesPayload } from "../../shared/types";

afterEach(cleanup);

const baseResumes: ResumesPayload = {
  directoryExists: true,
  files: [
    {
      name: "default.pdf",
      key: "default",
      bytes: 48_000,
      modifiedAt: "2026-10-23T12:00:00.000Z",
      reachability: "default",
    },
    {
      name: "denver.pdf",
      key: "denver",
      bytes: 52_000,
      modifiedAt: "2026-10-20T12:00:00.000Z",
      reachability: "region",
    },
  ],
  ruleGaps: [{ key: "chicago", expectedFile: "resumes/chicago.pdf" }],
  overrideActive: false,
  overridePath: null,
  overrideExists: null,
};

const resumeView: ProfileResumeView = {
  overridePath: null,
  overrideResolved: null,
  overrideExists: null,
  regionRules: [
    { key: "denver", terms: ["Denver", "Boulder", "Colorado"] },
    { key: "chicago", terms: ["Chicago"] },
  ],
};

describe("ProfileResumes", () => {
  it('uses the "Your resumes" heading and plain action labels', () => {
    render(
      <ProfileResumes
        resumes={baseResumes}
        resume={resumeView}
        hasRegionRules={true}
        onAssign={vi.fn()}
        regionMarkdown=""
        regionDirty={false}
        onRegionChange={() => {}}
        onRegionSave={() => {}}
        regionSaving={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your resumes" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Make default" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Use for all jobs" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Reachability/i)).toBeNull();
    expect(screen.queryByText(/Files in resumes/i)).toBeNull();
  });

  it("summarizes missing location resumes in the advanced disclosure", () => {
    render(
      <ProfileResumes
        resumes={baseResumes}
        resume={resumeView}
        hasRegionRules={true}
        onAssign={vi.fn()}
        regionMarkdown=""
        regionDirty={false}
        onRegionChange={() => {}}
        onRegionSave={() => {}}
        regionSaving={false}
      />,
    );
    expect(
      screen.getByText(/Location-specific resumes \(advanced\)/),
    ).toBeTruthy();
    expect(screen.getByText(/1 location has no resume yet/)).toBeTruthy();
  });
});
