/**
 * Workspace root resolution shared by the three job extensions.
 *
 * The repo IS the workspace: pi discovers project-local extensions at
 * `<cwd>/.pi/extensions`, so this file always sits three directories below the
 * workspace root. Deriving the root from the module's own location is exact no
 * matter how the process was started, which is what lets the extensions drop
 * their hardcoded path.
 *
 * Deliberately NOT honouring `PI_JOBS_ROOT` (which the UI server does honour):
 * the extensions gate every handler on `isInWorkspace(ctx.cwd)`, so an override
 * pointing somewhere other than the launch directory would silently make all
 * three extensions inert. Point the UI at a throwaway workspace; run pi inside
 * the workspace you mean.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `<workspace>/.pi/extensions/lib` → `<workspace>`. */
export const WORKSPACE: string = path.resolve(LIB_DIR, "..", "..", "..");

/** Join a workspace-relative path. */
export function wsPath(...segments: string[]): string {
  return path.join(WORKSPACE, ...segments);
}

/**
 * True when pi was launched from the workspace root. Every event handler and
 * command gates on this so a globally-installed copy of these extensions stays
 * inert in unrelated projects.
 */
export function isInWorkspace(cwd: string): boolean {
  return path.resolve(cwd) === WORKSPACE;
}
