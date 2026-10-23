import { describe, expect, it } from "vitest";
import { CURSOR_AUTH_BUTTONS, cursorNeedsNode24, cursorSignInStatusLine } from "../loginUiHelpers";
import type { ConnectionView } from "../../shared/config";

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "123e4567-e89b-12d3-a456-426614174099",
    label: "Cursor",
    provider: "cursor",
    credential: { configured: true, source: "app-store" },
    validation: { status: "untested", checkedAt: null },
    email: "dev@example.com",
    expiresAt: "2030-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("cursorSignInStatusLine", () => {
  it("formats signed-in copy with and without email", () => {
    expect(cursorSignInStatusLine(connection())).toMatch(/Signed in as dev@example.com/);
    expect(cursorSignInStatusLine(connection({ email: undefined }))).toMatch(/^Signed in · key expires/);
    expect(cursorSignInStatusLine(connection({ expiresAt: undefined }))).toBeNull();
  });
});

describe("cursorNeedsNode24", () => {
  it("flags node versions below 24", () => {
    expect(cursorNeedsNode24(23)).toBe(true);
    expect(cursorNeedsNode24(24)).toBe(false);
  });
});

describe("Cursor connection auth copy", () => {
  it("documents the button labels and node warning copy", () => {
    expect(CURSOR_AUTH_BUTTONS.signIn).toBe("Sign in with Cursor");
    expect(CURSOR_AUTH_BUTTONS.import).toBe("Use my existing Cursor login");
    expect(cursorNeedsNode24(22)).toBe(true);
    expect(CURSOR_AUTH_BUTTONS.nodeWarning).toBe("Cursor needs Node 24+");
  });
});
