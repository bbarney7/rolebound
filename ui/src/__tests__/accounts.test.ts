import { describe, expect, it } from "vitest";
import {
  accountUrl,
  filterAccounts,
  isLoginStatus,
  loginStatusLabel,
  loginStatusTone,
} from "../accounts";
import { enumUpdate, textUpdate } from "../AccountDetail";
import type { ATSAccount } from "../../shared/types";

/**
 * Node environment, no rendering: this directory has no jsdom and no
 * testing-library, so only pure helpers are covered here — those of
 * `src/accounts.ts`, plus `textUpdate` from `src/AccountDetail.tsx`, which is a
 * pure function living in a component module and is exported for this file. The
 * fetch wrappers are covered end-to-end by the server suite.
 */
function account(overrides: Partial<ATSAccount> = {}): ATSAccount {
  return {
    host: "acme.wd5.myworkdayjobs.com",
    username: "acme-user",
    emailUsed: "me@example.com",
    ats: "workday",
    company: "Acme",
    createdAt: "2026-07-01T00:00:00Z",
    lastUsedAt: "2026-07-22T17:05:00Z",
    lastLoginStatus: "success",
    notes: null,
    hasPassword: true,
    ...overrides,
  };
}

describe("filterAccounts", () => {
  const accounts = [
    account(),
    account({
      host: "careers-beta.icims.com",
      username: "beta-user",
      emailUsed: "other@example.com",
      company: "Beta",
      ats: "icims",
    }),
  ];

  it("matches on host", () => {
    expect(filterAccounts(accounts, "icims.com").map((a) => a.host)).toEqual([
      "careers-beta.icims.com",
    ]);
  });

  it("matches on company", () => {
    expect(filterAccounts(accounts, "Acme").map((a) => a.host)).toEqual([
      "acme.wd5.myworkdayjobs.com",
    ]);
  });

  it("matches on emailUsed", () => {
    expect(filterAccounts(accounts, "other@example").map((a) => a.host)).toEqual([
      "careers-beta.icims.com",
    ]);
  });

  it("matches on username", () => {
    expect(filterAccounts(accounts, "beta-user").map((a) => a.host)).toEqual([
      "careers-beta.icims.com",
    ]);
  });

  it("is case-insensitive in both directions", () => {
    expect(filterAccounts(accounts, "BETA").map((a) => a.host)).toEqual([
      "careers-beta.icims.com",
    ]);
    expect(filterAccounts([account({ company: "ACME" })], "acme")).toHaveLength(1);
  });

  it("returns everything for a blank or whitespace-only query", () => {
    expect(filterAccounts(accounts, "")).toEqual(accounts);
    expect(filterAccounts(accounts, "  ")).toEqual(accounts);
  });

  it("returns nothing when no account matches", () => {
    expect(filterAccounts(accounts, "zzz-nothing")).toEqual([]);
  });

  it("does not throw on nulls in any searchable field", () => {
    const sparse = [account({ username: null, emailUsed: null, company: null })];
    expect(() => filterAccounts(sparse, "acme")).not.toThrow();
    expect(filterAccounts(sparse, "acme")).toHaveLength(1);
    expect(filterAccounts(sparse, "me@example.com")).toEqual([]);
  });
});

describe("loginStatusTone / loginStatusLabel", () => {
  it("maps the three known statuses", () => {
    expect(loginStatusTone("success")).toBe("good");
    expect(loginStatusTone("failed")).toBe("crit");
    expect(loginStatusTone("pending")).toBe("warn");
  });

  it("maps null and an unrecognized value to the neutral tone", () => {
    expect(loginStatusTone(null)).toBe("neutral");
    expect(loginStatusTone("garbage")).toBe("neutral");
  });

  it("labels the value as stored, and only null as unknown", () => {
    expect(loginStatusLabel("success")).toBe("success");
    expect(loginStatusLabel("failed")).toBe("failed");
    expect(loginStatusLabel("pending")).toBe("pending");
    expect(loginStatusLabel("garbage")).toBe("garbage");
    expect(loginStatusLabel(null)).toBe("unknown");
  });

  it("guards the known statuses", () => {
    expect(isLoginStatus("success")).toBe(true);
    expect(isLoginStatus("garbage")).toBe(false);
    expect(isLoginStatus(null)).toBe(false);
  });
});

describe("accountUrl", () => {
  // Deliberately MORE PERMISSIVE than the server's normalizeHost (Decision 2):
  // its job is refusing an unsafe href, not deciding what may be created.
  it("links a plain hostname", () => {
    expect(accountUrl("acme.wd5.myworkdayjobs.com")).toBe("https://acme.wd5.myworkdayjobs.com");
  });

  it("preserves casing, because an uppercase key can exist on disk", () => {
    expect(accountUrl("HOST.COM")).toBe("https://HOST.COM");
  });

  it("accepts a port, which is exactly what extractHost produces", () => {
    expect(accountUrl("a.com:443")).toBe("https://a.com:443");
    expect(accountUrl("acme.example.com:8443")).toBe("https://acme.example.com:8443");
  });

  it("refuses anything that is not hostname-shaped", () => {
    expect(accountUrl("javascript:alert(1)")).toBeNull();
    expect(accountUrl("evil.com/path")).toBeNull();
    expect(accountUrl("a b")).toBeNull();
    expect(accountUrl("")).toBeNull();
    expect(accountUrl("a.com:notaport")).toBeNull();
  });

  it("range-checks the port rather than trusting the pattern", () => {
    // These two are exactly what a bare `:\d{1,5}` lets through.
    expect(accountUrl("a.com:65536")).toBeNull();
    expect(accountUrl("a.com:0")).toBeNull();
    expect(accountUrl("a.com:443")).toBe("https://a.com:443");
    expect(accountUrl("a.com:8443")).toBe("https://a.com:8443");
  });

  it("bounds the whole string and every label", () => {
    expect(accountUrl(`${"a".repeat(64)}.com`)).toBeNull();
    expect(accountUrl(`${"a".repeat(63)}.com`)).toBe(`https://${"a".repeat(63)}.com`);
    expect(accountUrl(`${Array.from({ length: 50 }, () => "abcde").join(".")}.com`)).toBeNull();
  });
});

/**
 * AccountDetail.tsx is a component module, but `textUpdate` is a pure function
 * and the bug it carried was a pure-function bug: it normalized before it
 * compared, so a field the user never touched could still reach the PATCH body.
 * It is exported for exactly this — no rendering is involved, and none is
 * possible here (see the note above).
 */
describe("textUpdate", () => {
  it("returns undefined for a field the user never touched, whatever is stored", () => {
    // The three shapes formFrom seeds a field with, each compared to itself.
    expect(textUpdate(null, "")).toBeUndefined();
    expect(textUpdate("", "")).toBeUndefined();
    expect(textUpdate("Acme", "Acme")).toBeUndefined();
  });

  it("does not treat its own normalization as an edit", () => {
    // The two regressions this ordering exists to prevent. Both used to be sent
    // by someone who only edited notes: the first rewrote a stored value, the
    // second DELETED one.
    expect(textUpdate(" Acme ", " Acme ")).toBeUndefined();
    expect(textUpdate("", "")).toBeUndefined();
  });

  it("still trims and blanks a field the user did edit", () => {
    expect(textUpdate("Acme", "  Globex  ")).toBe("Globex");
    expect(textUpdate("Acme", "")).toBeNull();
    expect(textUpdate("Acme", "   ")).toBeNull();
    expect(textUpdate(null, "Globex")).toBe("Globex");
    // Editing away the stored padding is a real edit and is sent.
    expect(textUpdate(" Acme ", "Acme")).toBe("Acme");
  });
});

/**
 * `enumUpdate` carried the identical normalize-then-compare bug `textUpdate`
 * did, in the same file, and it was found by reviewing the fix rather than by
 * the review that prompted it. It matters for the same reason: `ats` and
 * `last_login_status` are `string | null` on the wire because the reader
 * surfaces whatever a hand-edited file holds, so a stored `""` reaches the
 * select and used to come back as a DELETE for a user who edited only notes.
 */
describe("enumUpdate", () => {
  const ATS = ["workday", "greenhouse", "other"] as const;

  it("returns undefined for a select the user never touched", () => {
    expect(enumUpdate(null, "", ATS)).toBeUndefined();
    expect(enumUpdate("workday", "workday", ATS)).toBeUndefined();
  });

  it("does not treat its own normalization as an edit", () => {
    // The regression: a stored empty string seeded the select with "",
    // normalized back to null, compared unequal, and deleted the key.
    expect(enumUpdate("", "", ATS)).toBeUndefined();
  });

  it("keeps an unrecognized stored value while it is untouched", () => {
    expect(enumUpdate("greenhouse-eu", "greenhouse-eu", ATS)).toBeUndefined();
  });

  it("still clears and sets a select the user did change", () => {
    expect(enumUpdate("workday", "", ATS)).toBeNull();
    expect(enumUpdate("workday", "greenhouse", ATS)).toBe("greenhouse");
    expect(enumUpdate(null, "other", ATS)).toBe("other");
    // Replacing an unrecognized value with a known one is a real edit.
    expect(enumUpdate("greenhouse-eu", "workday", ATS)).toBe("workday");
  });
});
