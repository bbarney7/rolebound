// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme } from "../chat/theme";

describe("chat theme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("applyTheme sets and removes data-theme", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("readTheme survives a throwing localStorage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readTheme()).toBe("system");
    expect(() => applyTheme("dark")).not.toThrow();
  });
});
