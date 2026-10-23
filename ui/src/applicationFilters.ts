/** Aggregate UI filters expand locally; server contracts retain concrete states. */
export const APPLICATION_FILTERS: Record<string, readonly string[]> = {
  active: ["in_progress"], waiting: ["queued"], attention: ["paused_for_user", "blocked"],
};
export function matchesApplicationFilter(state: string, filter: string) {
  return filter === "all" || (APPLICATION_FILTERS[filter] ?? [filter]).includes(state);
}
