import type { Overview } from "../shared/types";

export type OverviewLoadFlags = {
  overviewLoaded: boolean;
  applicationsLoaded: boolean;
  accountsLoaded: boolean;
};

/**
 * Pure predicates for when overview-backed panels leave the loading state.
 * Treats corrupt files as loaded-with-error so the UI does not spin forever.
 */
export function overviewResourceLoadFlags(
  overview: Overview | null,
  applicationsCount: number,
  accountsCount: number,
): OverviewLoadFlags {
  const overviewLoaded = overview !== null;
  const corruptFiles = overview?.corrupt ?? [];
  const applicationsLoaded =
    overview !== null &&
    (overview.applications === null ||
      corruptFiles.includes("state.json") ||
      applicationsCount > 0 ||
      overview.applications.total === 0);
  const accountsLoaded =
    overview !== null &&
    (overview.accounts === null ||
      corruptFiles.includes("credentials.json") ||
      accountsCount > 0 ||
      overview.accounts === 0);
  return { overviewLoaded, applicationsLoaded, accountsLoaded };
}
