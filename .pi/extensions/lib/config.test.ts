import { describe, expect, it, vi } from "vitest";
import { adapterEnabled, isSafeSlug } from "./config";

/**
 * Builds the env object a single `adapterEnabled` call sees. `undefined` means
 * the variable is genuinely absent rather than set to the empty string — the
 * two are different bytes in a shell and the table asserts both.
 */
function envWith(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { PI_JOBS_ATS_ADAPTERS: value };
}

/**
 * The whole contract of the switch in one table. `greenhouse` and `ashby` are
 * asserted on every row because the interesting failures are asymmetric: a
 * naive `includes()` on the raw string would let `"ashby"` enable greenhouse
 * (it does not contain "greenhouse", but `"greenhouse-ashby"` style values and
 * substring checks are exactly how that bug arrives), and a fail-open default
 * would let `"garbage"` enable both.
 */
const CASES: Array<{
  value: string | undefined;
  greenhouse: boolean;
  ashby: boolean;
  name: string;
}> = [
  {
    value: undefined,
    greenhouse: true,
    ashby: true,
    name: "enables every adapter when PI_JOBS_ATS_ADAPTERS is unset",
  },
  {
    value: "",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter when PI_JOBS_ATS_ADAPTERS is set but empty",
  },
  {
    value: "1",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value 1",
  },
  {
    value: "true",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value true",
  },
  {
    value: "TRUE",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value TRUE, because the read is case-insensitive",
  },
  {
    value: "all",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value all",
  },
  // M2: `off` was accepted and `on` was not, so the obvious way to undo a rollback
  // fell through to the list branch and failed closed — the variable read as an
  // instruction to enable an adapter named "on", and quietly disabled everything.
  {
    value: "on",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value on, the opposite of off",
  },
  {
    value: "ON",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value ON, because the read is case-insensitive",
  },
  {
    value: "yes",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value yes",
  },
  {
    value: " yes ",
    greenhouse: true,
    ashby: true,
    name: "enables every adapter for the value yes padded with whitespace",
  },
  {
    value: "0",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for the value 0",
  },
  {
    value: " 0 ",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for the value 0 padded with whitespace",
  },
  {
    value: "false",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for the value false",
  },
  {
    value: "off",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for the value off",
  },
  {
    value: "none",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for the value none",
  },
  {
    value: "greenhouse",
    greenhouse: true,
    ashby: false,
    name: "enables only greenhouse for the one-name list greenhouse",
  },
  {
    value: "GREENHOUSE",
    greenhouse: true,
    ashby: false,
    name: "enables only greenhouse for the uppercase one-name list GREENHOUSE",
  },
  {
    value: "ashby",
    greenhouse: false,
    ashby: true,
    name: "enables only ashby for the one-name list ashby, leaving greenhouse off",
  },
  {
    value: "greenhouse,ashby",
    greenhouse: true,
    ashby: true,
    name: "enables both adapters for the comma list greenhouse,ashby",
  },
  {
    value: " greenhouse , ashby ",
    greenhouse: true,
    ashby: true,
    name: "enables both adapters for a comma list padded with whitespace",
  },
  {
    value: "garbage",
    greenhouse: false,
    ashby: false,
    name: "disables every adapter for an unrecognised value, failing closed rather than open",
  },
  {
    value: "greenhouse,garbage",
    greenhouse: true,
    ashby: false,
    name: "enables only the known name in a list mixing known and unknown names",
  },
  // Ruling F: once a value contains a comma it is a list, and a token that would
  // be a mode on its own is read as one more list entry. "all" inside a list is
  // not an adapter name, so it enables nothing; the mode branches only ever see
  // the whole, comma-free value.
  {
    value: "all,ashby",
    greenhouse: false,
    ashby: true,
    name: "reads all inside a comma list as a list entry rather than a mode, leaving greenhouse off",
  },
  {
    value: "1,greenhouse",
    greenhouse: true,
    ashby: false,
    name: "reads 1 inside a comma list as a list entry, so 1,greenhouse enables greenhouse alone",
  },
  {
    value: "on,ashby",
    greenhouse: false,
    ashby: true,
    name: "reads on inside a comma list as a list entry too, the same way all is read",
  },
];

describe("adapterEnabled", () => {
  it.each(CASES)("$name", ({ value, greenhouse, ashby }) => {
    expect(adapterEnabled("greenhouse", envWith(value))).toBe(greenhouse);
    expect(adapterEnabled("ashby", envWith(value))).toBe(ashby);
  });

  /**
   * The reason there is no module-level cache: Task 10's off-path test sets the
   * variable per case in one process, and a value memoised on first import
   * would make every case after the first read the wrong switch.
   */
  it("reads the env argument fresh on every call rather than caching the first value", () => {
    expect(adapterEnabled("greenhouse", envWith("greenhouse"))).toBe(true);
    expect(adapterEnabled("greenhouse", envWith("0"))).toBe(false);
    expect(adapterEnabled("greenhouse", envWith("all"))).toBe(true);
  });

  it("falls back to process.env when no env argument is given", () => {
    vi.stubEnv("PI_JOBS_ATS_ADAPTERS", "ashby");
    try {
      expect(adapterEnabled("greenhouse")).toBe(false);
      expect(adapterEnabled("ashby")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * Mirrors the table `ui/server/workspace.ts` is guarded by. Task 9 interpolates
 * the model-supplied slug into `.pi-jobs/scripts/<slug>-*.js`, so the traversal
 * rows are the load-bearing ones.
 */
describe("isSafeSlug", () => {
  it.each([
    { slug: "acme-senior-eng", safe: true, name: "accepts an ordinary lowercase hyphenated slug" },
    { slug: "Acme_Senior.Eng-2", safe: true, name: "accepts uppercase, underscores, dots and digits" },
    { slug: "acme senior eng", safe: false, name: "rejects a slug containing spaces" },
    { slug: "..", safe: false, name: "rejects the parent-directory segment" },
    { slug: "../../etc/passwd", safe: false, name: "rejects a traversal path" },
    { slug: "jobs/queue", safe: false, name: "rejects a slug containing a path separator" },
    { slug: "", safe: false, name: "rejects the empty slug" },
  ])("$name", ({ slug, safe }) => {
    expect(isSafeSlug(slug)).toBe(safe);
  });
});
