import { resolveQueueJob } from "../../../.pi/extensions/lib/queue-slug";
import { listQueue } from "../readers/jobFiles";

/** Same slug resolution as POST /api/runs for apply-next. */
export async function resolveApplyNextSlug(root: string): Promise<string | null> {
  const queue = await listQueue(root);
  if (queue.length === 0) return null;
  return resolveQueueJob(root, queue[0].slug).slug;
}
