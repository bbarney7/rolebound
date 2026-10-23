/**
 * Off-path proof for the ATS adapters extension (Decision 2 / Decision 3).
 *
 * This file lives under `lib/` on purpose. pi loads EVERY top-level `*.ts` /
 * `*.js` in `.pi/extensions/` as an extension (`dist/core/extensions/loader.js`,
 * `resolveExtensionEntries`), and a Vitest file loaded that way crashes pi at
 * startup with "Cannot read properties of undefined (reading 'config')". A
 * subdirectory is only loaded when it has an `index.ts` or a `package.json`
 * with `pi.extensions`, which `lib/` never will. The last test below guards
 * this so the mistake cannot come back.
 *
 * The claim under test is that with `PI_JOBS_ATS_ADAPTERS` off, this extension
 * changes nothing a model can see — the system prompt of a pi session in this
 * worktree is byte-identical to one in a checkout without the extension. An
 * extension has exactly two surfaces onto the system prompt: an event hook
 * registered through `pi.on` (`dist/core/extensions/types.d.ts:908` is the
 * `before_agent_start` overload) and a registered tool's `promptSnippet` /
 * `promptGuidelines` (same file, lines 352 and 354). This file drives the real
 * factory with a recording `pi` and asserts both surfaces are empty when the
 * switch is off — and, as a second belt, scans the module's own source for the
 * two tokens. The two proofs cover each other's blind spot: the recorder sees
 * any spelling of the call (`pi["on"]`, a destructured handle) but only on the
 * paths the factory actually runs, while the scan sees the whole file
 * — a hook buried inside an `execute` body included — but only that spelling.
 *
 * The extension imports `typebox`, which pi supplies to extensions as a virtual
 * module through jiti; it is not a root dependency. `vitest.config.mts` aliases
 * it to the copy bundled with the globally installed pi, so this test exercises
 * the same `Type.Object(...)` calls the real runtime does. See that file's
 * header. The other pi import (`ExtensionAPI`) is `import type`, erased before
 * anything has to resolve it, which is why only `typebox` needs the alias.
 */

/*
 * DEFERRED EVIDENCE — AC 1, real-pi tool-list diff.
 *
 * The structural proof below is the standing guarantee; this is the end-to-end
 * confirmation of the same claim against a live pi. It was NOT run for Task 10:
 * the provider's weekly limit was still in force. Run both commands once the
 * quota resets and paste the two lists into `progress.md`.
 *
 * It is worth running rather than assuming, because the tool list is only one of
 * the two ways this worktree could change the prompt. The other is prose: pi
 * inlines `AGENTS.md` into the system prompt verbatim on every run, so a
 * paragraph describing the adapter there would make the switched-off prompt
 * differ from main's by exactly that paragraph, no matter how inert the
 * extension is. That is why `AGENTS.md` on this branch is byte-identical to
 * main's, why every word of adapter documentation lives in `README.md` (which pi
 * never reads), and why the scan at the bottom of this file asserts the tokens
 * are absent from `AGENTS.md` and `CLAUDE.md`. A future edit that documents the
 * adapter in the operating manual falsifies AC 1 silently; that scan is what
 * catches it.
 *
 *   From this repository root (adapter extension present):
 *     PI_JOBS_ATS_ADAPTERS=0 pi --print --no-session --mode json \
 *     "list every tool you have by exact name, one per line, nothing else"
 *
 *   Repeat the same command from a separate checkout of `main` that has no
 *   `.pi/extensions/ats-adapters.ts` (a plain clone or worktree is fine).
 *
 * The second run is the control: `main` has no ats-adapters extension at all. Diff
 * the two tool lists: the diff must be empty. A non-empty diff falsifies AC 1
 * and this file's premise, whatever the assertions below say.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import atsAdaptersExtension, { browserRunCodeCallLine } from "../ats-adapters";

/** The four tools Task 9 registers, and the only four this extension may add. */
const TOOL_NAMES = [
  "greenhouse_get_form",
  "greenhouse_prepare_fill",
  "greenhouse_prepare_submit",
  "greenhouse_prepare_otp",
];

const SWITCH = "PI_JOBS_ATS_ADAPTERS";

/**
 * The adapter's whole standing cost in the system prompt: every `promptSnippet`
 * plus every `promptGuidelines` line across the four tools, in UTF-8 bytes (the
 * strings carry em dashes and arrows, so counting characters would understate
 * them). Everything else the adapter says to the model rides on tool *results*,
 * which are free — they exist only in the turn that asked for them.
 *
 * Decision 12: if a wording change puts the total over this cap, shorten the
 * wording. Raising the number needs a recorded decision, because the cap is the
 * only thing standing between "one more helpful sentence" and a prompt that
 * grows without anyone deciding it should.
 */
const PROMPT_BYTE_CAP = 3500;

/**
 * The factory's parameter type, taken from the factory itself rather than
 * imported from `@earendil-works/pi-coding-agent`: the test needs no pi module
 * of its own, and a fake that satisfies this type is by construction a fake of
 * whatever pi actually passes.
 */
type Pi = Parameters<typeof atsAdaptersExtension>[0];

interface Recording {
  pi: Pi;
  /** One entry per `pi.registerTool` call, in registration order. */
  tools: Record<string, unknown>[];
  /** One entry per `pi.on` call — the array that must stay empty. */
  hooks: { event: unknown }[];
  /** Every other member of `pi` the factory reached for. */
  touched: string[];
}

/**
 * A `pi` that records the two calls the extension is allowed to make and turns
 * every other member access into a recorded name plus a throwing stub. The
 * stub is the point: a future `pi.setSystemPrompt(...)` or
 * `pi.registerCommand(...)` is a third surface onto the prompt, and it has to
 * fail this test loudly rather than pass unnoticed through a permissive mock.
 */
function recordingPi(): Recording {
  const tools: Record<string, unknown>[] = [];
  const hooks: { event: unknown }[] = [];
  const touched: string[] = [];

  const allowed = {
    registerTool(definition: Record<string, unknown>): void {
      tools.push(definition);
    },
    on(event: unknown, _handler: unknown): void {
      hooks.push({ event });
    },
  };

  const pi = new Proxy(allowed, {
    get(target, property, receiver) {
      if (typeof property === "string" && property !== "registerTool" && property !== "on") {
        touched.push(property);
        return () => {
          throw new Error(`the extension used pi.${property}, which this test deliberately does not model`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  return { pi: pi as unknown as Pi, tools, hooks, touched };
}

/**
 * Set the switch for one case. The extension calls `adapterEnabled("greenhouse")`
 * with no env argument, so `process.env` is the only way in; `beforeEach` /
 * `afterEach` put the caller's value back either way.
 */
function setSwitch(value: string | undefined): void {
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
}

/** Run the real factory once against a fresh recorder. */
function runWith(value: string | undefined): Recording {
  setSwitch(value);
  const recording = recordingPi();
  atsAdaptersExtension(recording.pi);
  return recording;
}

/** Nothing registered, no hook, no other pi member touched. */
function expectInert(recording: Recording): void {
  expect(recording.tools).toEqual([]);
  expect(recording.hooks).toEqual([]);
  expect(recording.touched).toEqual([]);
}

/** The four tools, order-insensitive, each shaped the way pi requires. */
function expectTheFourTools(recording: Recording): void {
  expect(recording.tools).toHaveLength(TOOL_NAMES.length);
  expect(new Set(recording.tools.map((tool) => tool.name))).toEqual(new Set(TOOL_NAMES));

  let promptBytes = 0;

  for (const tool of recording.tools) {
    const where = `tool ${String(tool.name)}`;

    expect(typeof tool.promptSnippet, `${where}: promptSnippet must be a string`).toBe("string");
    expect((tool.promptSnippet as string).trim(), `${where}: promptSnippet must not be blank`).not.toBe("");
    promptBytes += Buffer.byteLength(tool.promptSnippet as string);

    if (tool.promptGuidelines !== undefined) {
      expect(Array.isArray(tool.promptGuidelines), `${where}: promptGuidelines must be an array`).toBe(true);
      const guidelines = tool.promptGuidelines as unknown[];
      expect(guidelines.length, `${where}: promptGuidelines must not be empty`).toBeGreaterThan(0);
      for (const line of guidelines) {
        expect(typeof line, `${where}: every promptGuideline must be a string`).toBe("string");
        expect((line as string).trim(), `${where}: no promptGuideline may be blank`).not.toBe("");
        promptBytes += Buffer.byteLength(line as string);
      }
    }

    expect(typeof tool.parameters, `${where}: parameters must be an object schema`).toBe("object");
    expect(tool.parameters, `${where}: parameters must not be null`).not.toBeNull();
    expect(typeof tool.execute, `${where}: execute must be a function`).toBe("function");
  }

  expect(
    promptBytes,
    `the four tools spend ${promptBytes} B of system prompt; shorten the wording rather than raise the cap`,
  ).toBeLessThan(PROMPT_BYTE_CAP);
}

describe("browserRunCodeCallLine", () => {
  it("emits the direct pi MCP tool name and filename object", () => {
    const path = ".pi-jobs/scripts/acme-role-submit.js";
    expect(browserRunCodeCallLine(path)).toBe(
      `mcp__job_playwright__browser_run_code_unsafe({ filename: ${JSON.stringify(path)} })`,
    );
  });
});

describe("atsAdaptersExtension off-path", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[SWITCH];
  });

  afterEach(() => {
    setSwitch(saved);
  });

  it("registers nothing and hooks nothing when PI_JOBS_ATS_ADAPTERS is 0", () => {
    expectInert(runWith("0"));
  });

  it("registers nothing when PI_JOBS_ATS_ADAPTERS names only another adapter", () => {
    expectInert(runWith("ashby"));
  });

  it("registers exactly the four greenhouse tools when PI_JOBS_ATS_ADAPTERS is unset", () => {
    const recording = runWith(undefined);
    expectTheFourTools(recording);
    expect(recording.hooks).toEqual([]);
    expect(recording.touched).toEqual([]);
  });

  it("registers exactly the four greenhouse tools when PI_JOBS_ATS_ADAPTERS is greenhouse", () => {
    const recording = runWith("greenhouse");
    expectTheFourTools(recording);
    expect(recording.hooks).toEqual([]);
  });

  /**
   * Ruling F, carried from Task 8 and frozen here: a mode token that appears
   * inside a comma list is read as a list entry, not as a mode. `all,ashby` is
   * therefore the two-name list `[all, ashby]` — neither of which is
   * `greenhouse` — and leaves this extension inert, while `1,greenhouse` is the
   * list `[1, greenhouse]` and turns it on. The rows also live in
   * `lib/config.test.ts`; this pair proves the ruling end to end, at the
   * registration surface rather than at the predicate.
   */
  it("stays inert for the list all,ashby, because a mode token inside a list is a list entry", () => {
    expectInert(runWith("all,ashby"));
  });

  it("registers the four tools for the list 1,greenhouse, whose second entry is a real adapter name", () => {
    expectTheFourTools(runWith("1,greenhouse"));
  });
});

/**
 * The executable half of a source file: block comments and whole-line `//`
 * comments removed. The strip is what makes the scan below honest —
 * `ats-adapters.ts` *documents* the absence of the hook ("There is deliberately
 * NO `before_agent_start` handler here"), so a raw substring search would trip
 * over the very prose that states the guarantee. Trailing `//` comments are
 * left in place on purpose: cutting each line at its first `//` would also cut
 * every `https://` inside a string literal, and a line truncated that way could
 * hide a real call from the scan.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("ats-adapters.ts source", () => {
  const code = withoutComments(
    readFileSync(fileURLToPath(new URL("../ats-adapters.ts", import.meta.url)), "utf8"),
  );

  it("contains no before_agent_start handler, so nothing can rewrite the system prompt", () => {
    expect(code).not.toContain("before_agent_start");
  });

  it("contains no pi.on call at all, so the extension registers no event hook on any path", () => {
    expect(code).not.toContain("pi.on(");
  });

  it("still registers the four tools it is supposed to, so the scan is reading live code", () => {
    // Guards the two assertions above against a stripper bug that silently
    // empties the source: an over-eager strip would make them vacuously true.
    for (const name of TOOL_NAMES) expect(code).toContain(name);
    expect(code.match(/pi\.registerTool\(/g) ?? []).toHaveLength(TOOL_NAMES.length);
  });
});

/**
 * The prompt's other surface, and the one no amount of `if (!adapterEnabled(...))
 * return` can protect: pi inlines `AGENTS.md` into the system prompt verbatim, and
 * Claude Code reads `CLAUDE.md` the same way. A sentence about the adapter in either
 * one is in the prompt whether the switch is on or off, which is precisely the
 * byte-identical claim AC 1 makes. So the adapter is documented in `README.md`, which
 * neither agent reads, and these three tokens must not appear in either manual.
 *
 * Read relative to this file rather than to the process's cwd, so the assertion holds
 * whichever directory Vitest is started from.
 */
describe("the two files that are inlined into an agent's prompt", () => {
  const FORBIDDEN = ["greenhouse_", "PI_JOBS_ATS_ADAPTERS", "ats-adapters"];

  it.each(["AGENTS.md", "CLAUDE.md"])(
    "%s names nothing from this extension, so the switched-off prompt matches main's",
    (name) => {
      const text = readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");
      // Guards against reading an empty or missing file, which would pass vacuously.
      expect(text.length, `${name} looks empty`).toBeGreaterThan(500);
      for (const token of FORBIDDEN) expect(text, `${name} mentions ${token}`).not.toContain(token);
    },
  );

  it("finds that documentation in README.md instead, so it was moved rather than deleted", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    for (const name of TOOL_NAMES) expect(readme, name).toContain(name);
    expect(readme).toContain("PI_JOBS_ATS_ADAPTERS");
    expect(readme).toContain("ats-adapters.ts");
  });
});

/**
 * pi treats every top-level `.ts`/`.js` in `.pi/extensions/` as an extension and
 * loads it at startup, so a test file there breaks `pi-jobs` for everyone. Tests
 * belong under `lib/`.
 */
describe("no test file is a top-level pi extension", () => {
  it("keeps *.test.ts out of .pi/extensions/", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    const offenders = readdirSync(dir).filter((name) => /\.test\.(ts|js)$/.test(name));
    expect(offenders, "move these under .pi/extensions/lib/").toEqual([]);
  });
});
