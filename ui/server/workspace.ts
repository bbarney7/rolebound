import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeSlug as sharedIsSafeSlug, WORKSPACE_FILES } from "../../.pi/extensions/lib/workspace-files";

/**
 * Production workspace root. `paths.*` are built from `WORKSPACE_FILES` in
 * `.pi/extensions/lib/workspace-files.ts` (D8). Readers take the root as a
 * parameter (test-friendly), and `index.ts` is the only caller of this.
 *
 * The repo IS the workspace, and this file is always `<workspace>/ui/server/`,
 * so the default root is two directories up. Deriving it from the module's own
 * location rather than the home directory is what lets a cloned repo work from
 * wherever it was cloned to, and it matches how the pi extensions resolve the
 * same root.
 *
 * `PI_JOBS_ROOT` overrides it so the dev server can be pointed at a throwaway
 * workspace. That matters because this feature is the first that DELETES files:
 * a walkthrough against the default root removes real pending jobs with no undo.
 * `npm run dev:fixture` sets it; `npm run seed:fixture` builds the workspace it
 * points at. The boot line in `index.ts` prints whichever root won, so the
 * operator can confirm before clicking anything.
 *
 * Trimmed and emptiness-checked because `PI_JOBS_ROOT=` (set but empty) must
 * fall through to the default rather than resolve to the process CWD.
 */
export function defaultWorkspaceRoot(): string {
  const override = process.env.PI_JOBS_ROOT?.trim();
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export type JobDir = "queue" | "applied" | "discovered";

export const isSafeSlug = sharedIsSafeSlug;

export const paths = {
  stateJson: (root: string) => path.join(root, WORKSPACE_FILES.state),
  credentials: (root: string) => path.join(root, WORKSPACE_FILES.credentials),
  settings: (root: string) => path.join(root, WORKSPACE_FILES.settings),
  gatherState: (root: string) => path.join(root, WORKSPACE_FILES.gatherState),
  jobsDir: (root: string, dir: JobDir) => path.join(root, "jobs", dir),
  jobFile: (root: string, dir: JobDir, slug: string) =>
    path.join(root, "jobs", dir, `${slug}.md`),
  profile: (root: string) => path.join(root, WORKSPACE_FILES.profile),
  instructions: (root: string) => path.join(root, WORKSPACE_FILES.instructions),
  targets: (root: string) => path.join(root, WORKSPACE_FILES.targets),
  profileTemplate: (root: string) => path.join(root, "templates", "profile.template.md"),
  resumesDir: (root: string) => path.join(root, "resumes"),
  uiState: (root: string) => path.join(root, "ui", "ui-state.json"),
  /** the run manager's metadata file, and the target proper-lockfile locks (D3) */
  runManager: (root: string) => path.join(root, "ui", "run-manager.json"),
  screenshotsDir: (root: string) => path.join(root, "screenshots"),
};

/** Coerce gray-matter/js-yaml date parsing (Date objects) and strings to ISO, or null. */
export function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Date-only strings ("2026-06-17") parse as UTC midnight — fine for ordering.
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? trimmed : d.toISOString();
}
