/**
 * The single switch that gates the ATS adapter extension, plus the slug guard
 * the adapter needs before it writes a file named after model-supplied input.
 *
 * Deliberately dependency-free: no `@earendil-works/pi-coding-agent`, no
 * `node:fs`, nothing from `ui/`. The adapter's factory calls `adapterEnabled`
 * as its first statement, and Vitest imports this module directly — a pi
 * import would make it unloadable outside a pi process, and a `ui/` import
 * would make the extension depend on the UI package.
 */

/**
 * `ashby` is accepted today even though only the greenhouse adapter exists, so
 * the `ashby-adapter` work inherits this mechanism unchanged (Decision 2).
 */
export type AdapterName = "greenhouse" | "ashby";

/** Values that mean "every adapter is on". The empty string is here because
 * `PI_JOBS_ATS_ADAPTERS=` (set but empty) must behave like unset, the same
 * trim-and-default discipline `readRunConfig` applies (ui/server/runConfig.ts:28-33).
 * `on` and `yes` are here because the variable fails closed: someone who writes
 * the obvious opposite of `off` should get the adapter, not a silent disable. */
const ON_TOKENS = new Set(["", "1", "true", "all", "on", "yes"]);

/** Values that mean "every adapter is off". */
const OFF_TOKENS = new Set(["0", "false", "off", "none"]);

/**
 * Is `name` enabled by `PI_JOBS_ATS_ADAPTERS`?
 *
 * Unset, `""`, `1`, `true`, `all`, `on`, `yes` turn every adapter on; `0`,
 * `false`, `off`, `none` turn every adapter off; anything else is read as a comma-separated
 * list of adapter names and enables only the names it contains. The read is
 * case-insensitive and tolerant of whitespace around the value and around each
 * list entry.
 *
 * Unrecognised input FAILS CLOSED. `PI_JOBS_ATS_ADAPTERS=garbage` disables
 * every adapter rather than falling back to the on-by-default branch, because
 * a typo in the variable ("greehouse", "gh", "ok") must not silently leave the
 * adapter running when the operator's intent was plainly to control it. It
 * falls out of the list branch for free: "garbage" is simply not an adapter
 * name. A list that mixes known and unknown names enables the known ones.
 *
 * The env is read once per call from the `env` argument, with no module-level
 * memoisation, so a test can pass a different env per case within one process.
 *
 * Decision 8: this is a local, non-secret behaviour flag for a tool that runs
 * on one machine. The global rule that env vars are provisioned through GCP
 * Secret Manager and the `reeva_scripts` deploy/local scripts governs the Reeva
 * stack and is recorded as not applicable here.
 */
export function adapterEnabled(
  name: AdapterName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = (env.PI_JOBS_ATS_ADAPTERS ?? "").trim().toLowerCase();
  if (ON_TOKENS.has(value)) return true;
  if (OFF_TOKENS.has(value)) return false;
  // Ruling F: a mode token in a list is a list entry — "all,ashby" enables ashby, not all.
  return value
    .split(",")
    .map((entry) => entry.trim())
    .includes(name);
}

/**
 * Copied verbatim from `ui/server/workspace.ts:32,46-48` rather than imported:
 * this file must stay free of `ui/` imports (the extension cannot depend on the
 * UI package), and there is no shared package between the two trees. The copy
 * is small and the rule is frozen; `config.test.ts` pins the behaviour on this
 * side so a divergence shows up as a failing test rather than as a traversal.
 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Task 9 interpolates a model-supplied slug straight into
 * `.pi-jobs/scripts/<slug>-*.js` (Decision 9), so this must run before that
 * path is built. The character class alone is NOT sufficient: "." and "-" are
 * both members, so ".." matches SLUG_PATTERN — hence the explicit segment
 * rejection.
 */
export function isSafeSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !slug.includes("..");
}
