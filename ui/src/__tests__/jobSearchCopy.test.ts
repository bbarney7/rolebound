import { describe, expect, it } from "vitest";
import { shortlistTopbarSub } from "../jobSearchCopy";

describe("shortlistTopbarSub", () => {
  it("uses plain counts", () => {
    expect(shortlistTopbarSub(0)).toBe("No roles yet");
    expect(shortlistTopbarSub(1)).toBe("1 role ready to apply");
    expect(shortlistTopbarSub(3)).toBe("3 roles ready to apply");
  });
});
