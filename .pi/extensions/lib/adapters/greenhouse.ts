// Greenhouse job-board adapter.
//
// This module is the adapter's whole public surface. The implementation lives beside it in
// `greenhouse/`, split so neither half runs long: `greenhouse/schema.ts` reads a posting
// (URL parsing, the Job Board API fetch, schema compaction) and `greenhouse/answers.ts`
// answers one (selectors, the answer template, answer validation), and
// `greenhouse/scripts.ts` generates the browser scripts that fill, submit and verify it.
//
// Every part of it is deliberately free of pi imports (no `@earendil-works/pi-coding-agent`,
// no typebox) so Vitest can import it directly; the pi extension in `.pi/extensions/` is the
// only place that wires these functions to tools.

export { compactSchema, fetchJobSchema, parseGreenhouseUrl } from "./greenhouse/schema";
export type {
  CompactQuestion,
  CompactSchema,
  FetchJobSchemaOptions,
  FetchJobSchemaResult,
  GreenhouseJobRef,
  ParseGreenhouseUrlOptions,
  ParseGreenhouseUrlResult,
} from "./greenhouse/schema";

export {
  buildAnswerTemplate,
  DECLINE_ANSWER,
  elementRef,
  groupRefFor,
  isValidElementId,
  selectorFor,
  validateAnswers,
} from "./greenhouse/answers";
export type {
  AnswerHint,
  AnswerTemplate,
  ResolvedAnswer,
  ValidateAnswersResult,
} from "./greenhouse/answers";

export { generateFillScript, generateOtpScript, generateSubmitScript } from "./greenhouse/scripts";
export type {
  FieldError,
  FilledField,
  FillResult,
  OtpResult,
  SkippedField,
  SubmitResult,
} from "./greenhouse/scripts";
