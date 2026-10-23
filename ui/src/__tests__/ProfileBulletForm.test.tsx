// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import ProfileBulletForm from "../ProfileBulletForm";
import { changedBullets } from "../profile";
import type { ProfileBullet } from "../../shared/types";

afterEach(cleanup);

const FALLBACK_PLACEHOLDER =
  "*(optional — used only when an ATS signup form rejects `+aliasing`)*";

describe("ProfileBulletForm placeholders", () => {
  it("shows an empty value with a cleaned placeholder hint", () => {
    const bullets: ProfileBullet[] = [
      { key: "fallbackEmail", label: "Fallback email", value: FALLBACK_PLACEHOLDER },
    ];
    render(
      <ProfileBulletForm
        id="identity"
        bullets={bullets}
        drafts={{}}
        parsed={[]}
        parsedNote=""
        dirty={false}
        saving={false}
        error={null}
        note={null}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    const input = screen.getByLabelText("Fallback email") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(
      "optional — used only when an ATS signup form rejects +aliasing",
    );
  });
});

describe("changedBullets with template placeholders", () => {
  const bullets: ProfileBullet[] = [
    { key: "fallbackEmail", label: "Fallback email", value: FALLBACK_PLACEHOLDER },
    { key: "email", label: "Email", value: "me@example.com" },
  ];

  it("does not write an untouched placeholder on save", () => {
    const drafts = {
      "identity.fallbackEmail": FALLBACK_PLACEHOLDER,
      "identity.email": "me@example.com",
    };
    expect(changedBullets("identity", bullets, drafts)).toEqual({});
  });

  it("replaces a placeholder when the user types a value", () => {
    const drafts = {
      "identity.fallbackEmail": "backup@example.com",
      "identity.email": "me@example.com",
    };
    expect(changedBullets("identity", bullets, drafts)).toEqual({
      fallbackEmail: "backup@example.com",
    });
  });
});
