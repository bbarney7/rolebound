import { describe, expect, it } from "vitest";
import { isKnownCursorPiModelId, listCursorPiModelIds } from "./cursorModels";

describe("cursor model catalog", () => {
  it("includes composer-2.5 and excludes raw gpt-5.5", () => {
    const ids = listCursorPiModelIds();
    expect(ids).toContain("composer-2.5");
    expect(ids).not.toContain("gpt-5.5");
    expect(isKnownCursorPiModelId("composer-2.5")).toBe(true);
    expect(isKnownCursorPiModelId("gpt-5.5")).toBe(false);
  });
});
