import { evaluateApplyRunGate } from "../../.pi/extensions/lib/submission-policy";
import type { RunManagerOptions } from "./runs/runManager";
import { applyReadinessBlocker } from "./runReadiness";
import type { ProviderRuntime } from "./providers/hostDeps";

export function createApplyGate(
  root: string,
  demo: boolean,
  runtime: ProviderRuntime,
): NonNullable<RunManagerOptions["applyGate"]> {
  return async (rootArg, slug) => {
    const result = await evaluateApplyRunGate(rootArg, slug, { skipRateLimit: demo });
    if (!result.ok) {
      return { code: result.code, message: result.message, retryAfterMs: result.retryAfterMs };
    }
    const readiness = await applyReadinessBlocker(rootArg, { slug }, runtime);
    if (readiness) {
      return { code: readiness.code, message: readiness.message };
    }
    return null;
  };
}
