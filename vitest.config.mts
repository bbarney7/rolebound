/**
 * pi hands extensions `typebox` (and `@earendil-works/pi-coding-agent`) as virtual
 * modules through jiti, so neither is a root dependency and neither resolves from
 * `node_modules`. `ats-adapters.offpath.test.ts` imports the extension for real, which
 * means Vitest has to resolve `typebox` itself. The alias below points at the copy
 * bundled with the globally installed pi that runs this workspace — the same bytes the
 * real runtime hands the extension, which is why it is an alias to the actual package
 * and not a stub: a stub would prove the test's own `Type.Object` and not pi's.
 *
 * The `@earendil-works/pi-coding-agent` import needs no alias: it is `import type`, so
 * it is erased before anything has to resolve it. Only add `typebox/value`,
 * `typebox/compile` and friends here if an extension ever imports one — today none do,
 * and the exact-match regex keeps a subpath from being silently rewritten.
 *
 * These absolute paths are machine-specific for the same reason `tsconfig.json`'s
 * `paths` are (see the note there): the repo is single-user and single-machine.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only under lib/: pi loads every top-level .ts in .pi/extensions/ as an
    // extension, so a test file there crashes pi at startup.
    include: [".pi/extensions/lib/**/*.test.ts"],
    // *.live.test.ts hit the real network and are opt-in, never part of `npm test`.
    // ui/ has its own Vitest project; node_modules is never ours.
    exclude: ["**/*.live.test.ts", "ui/**", "node_modules/**"],
    // The adapter tests arrive in later tasks. Without this, a plain `vitest run`
    // that finds no test files exits 1.
    passWithNoTests: true,
  },
});
