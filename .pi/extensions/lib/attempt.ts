/**
 * Normalises the two shapes `update_application_state` (job-applier.ts)
 * accepts for recording an attempt on an application.
 *
 * The tool documents a nested `attempt` object (`started_at`, `ended_at?`,
 * `outcome`, `notes?`), but the model has repeatedly sent flat
 * `attempt_outcome`/`attempt_notes` instead, which the tool used to silently
 * ignore — 7 of 49 submitted applications show an empty `attempts[]`. Both
 * shapes are accepted here: `attempt` wins when both are given (it is the
 * richer, documented shape), and the flat pair is normalised into it,
 * defaulting `started_at` to now. `attempt_notes` alone, without
 * `attempt_outcome`, isn't an attempt and is ignored.
 *
 * `Attempt` is a type alias rather than an interface on purpose: the caller
 * pushes the result onto an `Array<Record<string, unknown>>`, and only a type
 * literal (not an interface) gets TypeScript's implicit index signature, so
 * an interface here would fail that assignment under `strict`.
 */

export type Attempt = {
  started_at: string;
  ended_at?: string;
  outcome: string;
  notes?: string;
};

export type AttemptParams = {
  attempt?: Attempt;
  attempt_outcome?: string;
  attempt_notes?: string;
};

export function resolveAttempt(params: AttemptParams): Attempt | undefined {
  if (params.attempt) return params.attempt;
  if (params.attempt_outcome === undefined) return undefined;
  const attempt: Attempt = { started_at: new Date().toISOString(), outcome: params.attempt_outcome };
  if (params.attempt_notes !== undefined) attempt.notes = params.attempt_notes;
  return attempt;
}
