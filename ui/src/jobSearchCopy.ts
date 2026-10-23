export function shortlistTopbarSub(queueCount: number): string {
  if (queueCount === 0) return "No roles yet";
  if (queueCount === 1) return "1 role ready to apply";
  return `${queueCount} roles ready to apply`;
}
