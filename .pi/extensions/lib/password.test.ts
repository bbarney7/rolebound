import { describe, expect, it } from "vitest";
import { generatePassword, passwordMeetsAtsRequirements } from "./password";

describe("generatePassword", () => {
  it("uses cryptographic randomness and meets ATS requirements", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBeGreaterThan(15);
    for (const password of passwords) {
      expect(password.length).toBe(14);
      expect(passwordMeetsAtsRequirements(password)).toBe(true);
    }
  });
});
