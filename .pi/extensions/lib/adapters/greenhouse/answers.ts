// Greenhouse job-board adapter: answering a posting.
//
// Selectors, the blank answer template the model fills in, and the validation that pairs a
// filled-in template with the elements its answers belong to. Imported through the
// `../greenhouse` barrel, never directly.
//
// Free of pi imports for the same reason `schema.ts` is: Vitest imports it directly.

import { asRecord, clip, ELEMENT_ID_RE } from "./schema";
import type { CompactQuestion, CompactSchema } from "./schema";

// ── Selectors ──

/** An id a CSS id selector can carry: `#4001539002` and `#question_67918863[]` both throw in querySelector. */
const PLAIN_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Is `id` safe to interpolate into a selector? Compaction already drops ids that fail this,
 * so a false here means the schema was built somewhere other than `compactSchema`.
 */
export function isValidElementId(id: unknown): id is string {
  return typeof id === "string" && ELEMENT_ID_RE.test(id);
}

/**
 * The selector fragment that names one element: `#id` when the id is a plain identifier,
 * the attribute form otherwise — a bare-numeric demographic id or a `[]`-suffixed
 * multi-select id. Throws rather than returning a broken fragment: `id` comes from network
 * JSON, and a caller that skipped compaction's validation must not get a string it will
 * paste into a generated script.
 */
export function elementRef(id: string): string {
  if (!isValidElementId(id)) {
    throw new Error(
      `Refusing to build a selector from id ${JSON.stringify(clip(String(id)))}: an id must match ${ELEMENT_ID_RE.source}.`,
    );
  }
  return PLAIN_ID_RE.test(id) ? `#${id}` : `[id="${id}"]`;
}

/**
 * The selector that reaches the checkbox group some boards render a `multi_value_multi_select`
 * as, in place of a react-select: one `<input type="checkbox">` per option, all sharing the
 * question's `name`, each with an id of its own and a `<label for>` carrying the option text.
 *
 * A sibling of `elementRef` rather than a line inside the fill template, so the quoting rule
 * lives in one place and the id goes through the same validation every other selector does
 * (Decision 9). `ELEMENT_ID_RE` admits no quote character, so the interpolation cannot escape
 * the attribute value; it throws on anything it does not recognise all the same.
 */
export function groupRefFor(id: string): string {
  if (!isValidElementId(id)) {
    throw new Error(
      `Refusing to build a selector from id ${JSON.stringify(clip(String(id)))}: an id must match ${ELEMENT_ID_RE.source}.`,
    );
  }
  return `input[type="checkbox"][name="${id}"]`;
}

/**
 * The CSS selector that reaches one question's element on the rendered application page.
 *
 * The shapes are the ones the scout confirmed against live Greenhouse postings: a select is
 * a headless combobox `<input role="combobox">` rather than a `<select>`, and a file question
 * is the `<input type="file">` behind the drop zone. Two kinds of id cannot be written as
 * `#id` and go through `elementRef`'s attribute form instead: a demographic question's bare
 * number, because `querySelector('#4001539002')` throws on an id selector starting with a
 * digit, and a `multi_value_multi_select`'s `question_<n>[]`, because the brackets there read
 * as an attribute selector of their own. The demographic form is already unambiguous, so it
 * carries no further qualifier; every other id keeps the qualifier its type earns.
 */
export function selectorFor(q: CompactQuestion): string {
  const ref = elementRef(q.id);
  // A bare-numeric demographic id keeps the bare attribute form the scout confirmed.
  if (/^\d+$/.test(q.id)) return `input${ref}`;
  // Exhaustive on purpose: a sixth field type has to come with a selector of its own, and
  // TypeScript will point at this switch rather than let it fall through to a text input.
  switch (q.type) {
    case "input_text":
      return `input${ref}`;
    case "textarea":
      return `textarea${ref}`;
    case "input_file":
      return `input${ref}[type=file]`;
    case "multi_value_single_select":
    case "multi_value_multi_select":
    case "unlisted_select":
      return `input${ref}[role=combobox]`;
  }
}

// ── Answer template ──

/** What the model is told about one question so it can answer it; never a selector. */
export interface AnswerHint {
  label: string;
  type: CompactQuestion["type"];
  required: boolean;
  options?: string[];
  declineOption?: string;
  twinOf?: string;
}

export interface AnswerTemplate {
  /** The object the model fills in and sends back, and the dry-run answers-file format. */
  answers: Record<string, "">;
  hints: Record<string, AnswerHint>;
}

/**
 * Split a compacted schema into the blank object the model fills in and the per-question
 * hints it reads. Keeping the two apart means the reply is exactly the answers object: no
 * hint text to strip, and nothing to merge before `validateAnswers` sees it.
 */
export function buildAnswerTemplate(schema: CompactSchema): AnswerTemplate {
  const answers: Record<string, ""> = {};
  const hints: Record<string, AnswerHint> = {};

  for (const q of schema.questions) {
    answers[q.id] = "";
    const hint: AnswerHint = { label: q.label, type: q.type, required: q.required };
    if (q.options !== undefined) hint.options = q.options;
    if (q.declineOption !== undefined) hint.declineOption = q.declineOption;
    if (q.twinOf !== undefined) hint.twinOf = q.twinOf;
    hints[q.id] = hint;
  }

  return { answers, hints };
}

// ── Answer validation ──

/** One question paired with the answer that will be typed into it. */
export interface ResolvedAnswer {
  id: string;
  label: string;
  type: CompactQuestion["type"];
  source: CompactQuestion["source"];
  /** Always an array on a `multi_value_multi_select`, always a string otherwise. */
  value: string | string[];
  selector: string;
  /**
   * For a `multi_value_multi_select`, the checkbox group Greenhouse renders instead of a
   * react-select on some boards: `input[type="checkbox"][name="question_68440829[]"]`,
   * with one box per option and ids `<id>_<greenhouseOptionId>`. Built here rather than in
   * the template so the id goes through the same validation every other selector does
   * (Decision 9); the template only ever reads it out of the data literal, and only after
   * the react-select `selector` has come back empty.
   */
  groupSelector?: string;
  /**
   * The file field this answer is the paste-the-text twin of, when it is one. Carried
   * through to the fill script, which has to click "Enter manually" before the textarea
   * this selector points at exists in the DOM at all.
   */
  twinOf?: string;
}

export interface ValidateAnswersResult {
  /** True only when nothing is wrong and nothing required is missing. */
  ok: boolean;
  resolved: ResolvedAnswer[];
  /** Ids of required questions with no usable answer; the caller has to go back and ask. */
  unanswered: string[];
  /** Blocking: an answer that cannot be typed anywhere. Each entry names the question. */
  errors: string[];
  /** Non-blocking: something was dropped on purpose and the caller should know why. */
  notes: string[];
}

/** The answer a caller sends to take whatever wording this board uses for a decline. */
export const DECLINE_ANSWER = "__decline__";

/**
 * How a model phrases a decline when it does not copy the board's own label. Matched only
 * against answers to option questions — a free-text answer may say "decline" and mean it.
 */
const DECLINE_ANSWER_RE = /prefer not to answer|decline/i;

/** Option labels for an error. EEOC lists run to kilobytes, so the join is capped. */
function clipList(labels: string[]): string {
  const joined = labels.map((label) => JSON.stringify(label)).join(", ");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return `a ${typeof value}`;
}

/**
 * A question whose answer has to be one of its labels: any select, and anything with options.
 *
 * `unlisted_select` is deliberately left out: the API enumerates no labels for the location
 * combobox, so there is nothing to match an answer against, and naming the type here would
 * send every such answer through `matchOption`'s empty-options branch and reject it. Its
 * answers are taken as typed, which is what a type-ahead expects anyway.
 */
function isOptionQuestion(q: CompactQuestion): boolean {
  return (
    q.options !== undefined ||
    q.type === "multi_value_single_select" ||
    q.type === "multi_value_multi_select"
  );
}

/** Is this raw answer worth anything? Used to decide whether a twin's parent is answered. */
function isNonEmptyAnswer(raw: unknown): boolean {
  if (typeof raw === "string") return raw.trim() !== "";
  if (Array.isArray(raw)) return raw.some((item) => typeof item === "string" && item.trim() !== "");
  return false;
}

/**
 * Narrow one raw answer to the trimmed strings it holds, or say why it is not an answer.
 * An empty result means "answered with nothing", which is unanswered rather than wrong.
 */
function answerValues(q: CompactQuestion, raw: unknown): string[] | { error: string } {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value === "" ? [] : [value];
  }
  if (Array.isArray(raw)) {
    if (q.type !== "multi_value_multi_select") {
      return {
        error: `\`${q.id}\` (${clip(q.label)}) has type \`${q.type}\` and takes a single value, not a list; only a multi_value_multi_select takes a list.`,
      };
    }
    const values: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") {
        return { error: `\`${q.id}\` was given a list holding ${describeValue(item)}; every entry must be a string.` };
      }
      const value = item.trim();
      if (value !== "") values.push(value);
    }
    return values;
  }
  return {
    error: `\`${q.id}\` was given ${describeValue(raw)}; an answer is a string, or a list of strings on a multi_value_multi_select.`,
  };
}

/**
 * Resolve one value against an option question's labels.
 *
 * Exact match first, so an option whose own wording reads like a decline ("Decline To Self
 * Identify") is taken literally instead of being routed through the decline branch. Nothing
 * is ever fuzzy-matched: "yes" is not "Yes", because guessing here silently answers a
 * legally meaningful question wrong.
 */
function matchOption(q: CompactQuestion, value: string): { label: string } | { error: string } {
  const options = q.options ?? [];
  if (options.length === 0) {
    return {
      error: `\`${q.id}\` (${clip(q.label)}) has type \`${q.type}\` but the schema lists no options for it, so no answer can be checked; it has to be filled in the browser.`,
    };
  }
  if (options.includes(value)) return { label: value };
  if (value === DECLINE_ANSWER || DECLINE_ANSWER_RE.test(value)) {
    if (q.declineOption !== undefined) return { label: q.declineOption };
    return {
      error: `\`${q.id}\` (${clip(q.label)}) offers no decline option, so ${JSON.stringify(clip(value))} cannot be used. Valid labels: ${clipList(options)}.`,
    };
  }
  return {
    error: `${JSON.stringify(clip(value))} is not an option of \`${q.id}\` (${clip(q.label)}); labels are matched exactly. Valid labels: ${clipList(options)}.`,
  };
}

/**
 * Check a model-supplied answers object against the schema it was built from and pair every
 * usable answer with the selector that will receive it.
 *
 * Nothing is guessed and nothing is defaulted: an answer that does not match becomes an
 * error naming the valid labels, a required question with no answer becomes an `unanswered`
 * id, and both block. `answers` is untrusted model output, so every value is narrowed before
 * it is used and this function never throws.
 */
export function validateAnswers(
  schema: CompactSchema,
  answers: Record<string, unknown>,
): ValidateAnswersResult {
  const resolved: ResolvedAnswer[] = [];
  const unanswered: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];

  const questions = schema.questions;
  const given = asRecord(answers) ?? {};

  // Two questions sharing an id would resolve to one selector; filling either silently
  // answers the wrong question, so neither is filled.
  const counts = new Map<string, number>();
  for (const q of questions) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
  const duplicated = new Set<string>();
  for (const [id, count] of counts) {
    if (count === 1) continue;
    duplicated.add(id);
    errors.push(
      `The schema has ${count} questions with id \`${clip(id)}\`; one selector cannot answer both, so neither is filled.`,
    );
  }

  for (const key of Object.keys(given)) {
    if (!counts.has(key)) {
      errors.push(`Unknown question \`${clip(key)}\`: this job's schema has no such field to fill.`);
    }
  }

  // A twin is dropped only when its file parent actually carries an answer, so this is read
  // before the loop reaches either half of the pair.
  const answered = new Set<string>();
  for (const [key, raw] of Object.entries(given)) {
    if (isNonEmptyAnswer(raw)) answered.add(key);
  }

  /**
   * Is this required question already satisfied by the other half of its pair?
   *
   * "Resume/CV" is one question rendered as two elements — the upload and the `_text`
   * textarea behind "Enter manually" — and Greenhouse marks both `required` because either
   * one satisfies it. Reporting the empty half as `unanswered` would block a complete answer
   * set: `prepare_fill` writes no script while anything is unanswered, so a caller that
   * pasted its resume text would be told to also upload a file, and one that uploaded a file
   * would be told to also paste the text. Both directions are covered — a twin whose parent
   * is answered, and a parent whose twin is answered.
   */
  const pairAnswered = (q: CompactQuestion): boolean =>
    (q.twinOf !== undefined && answered.has(q.twinOf)) ||
    questions.some((other) => other.twinOf === q.id && answered.has(other.id));

  /** Record a required question with nothing in it, unless its twin already answered it. */
  const missing = (q: CompactQuestion): void => {
    if (q.required && !pairAnswered(q)) unanswered.push(q.id);
  };

  for (const q of questions) {
    if (duplicated.has(q.id)) continue;
    if (!isValidElementId(q.id)) {
      // compactSchema drops these, so this only fires on a hand-built schema.
      errors.push(`Question id ${JSON.stringify(clip(String(q.id)))} cannot be used as a selector, so it is skipped.`);
      continue;
    }

    const raw = Object.prototype.hasOwnProperty.call(given, q.id) ? given[q.id] : undefined;
    if (raw === undefined) {
      missing(q);
      continue;
    }

    const values = answerValues(q, raw);
    if (!Array.isArray(values)) {
      errors.push(values.error);
      continue;
    }
    if (values.length === 0) {
      missing(q);
      continue;
    }

    // "Resume/CV" is one question with two elements; answering both would upload a file and
    // paste its text, and the board keeps whichever it saw last.
    if (q.twinOf !== undefined && answered.has(q.twinOf)) {
      notes.push(
        `Dropped the answer to \`${q.id}\`: its file field \`${q.twinOf}\` is answered too, and only one of the pair can be filled.`,
      );
      continue;
    }

    let labels = values;
    if (isOptionQuestion(q)) {
      const matched: string[] = [];
      let failed = false;
      for (const value of values) {
        const match = matchOption(q, value);
        if ("error" in match) {
          errors.push(match.error);
          failed = true;
          break;
        }
        matched.push(match.label);
      }
      if (failed) continue;
      // Deduplicated before the guard below, so a decline sent twice (as the literal and as
      // the board's own wording) is one tick rather than a mix. A repeat would click the
      // same option twice anyway, and the second click on a react-select multi takes it off.
      labels = [...new Set(matched)];
      // A decline is an answer to the whole question, so ticking it next to a real label
      // submits both "I decline" and a self-identification on the same EEOC field.
      if (q.declineOption !== undefined && labels.length > 1 && labels.includes(q.declineOption)) {
        const others = labels.filter((label) => label !== q.declineOption);
        errors.push(
          `\`${q.id}\` (${clip(q.label)}) was answered with both ${JSON.stringify(clip(q.declineOption))} and ${clipList(others)}; a decline and a real answer cannot both be ticked. Send one or the other.`,
        );
        continue;
      }
    } else if (values.includes(DECLINE_ANSWER)) {
      // Typing the literal into a free-text field would submit "__decline__" as the answer.
      errors.push(
        `\`${q.id}\` (${clip(q.label)}) has type \`${q.type}\` and no options, so ${JSON.stringify(DECLINE_ANSWER)} is not an answer for it.`,
      );
      continue;
    }

    const answer: ResolvedAnswer = {
      id: q.id,
      label: q.label,
      type: q.type,
      source: q.source,
      value: q.type === "multi_value_multi_select" ? labels : labels[0],
      selector: selectorFor(q),
    };
    // Only a multi-select is ever rendered as a checkbox group, and the fill falls back to
    // it only when the react-select is not on the page at all.
    if (q.type === "multi_value_multi_select") answer.groupSelector = groupRefFor(q.id);
    if (q.twinOf !== undefined) answer.twinOf = q.twinOf;
    resolved.push(answer);
  }

  return { ok: errors.length === 0 && unanswered.length === 0, resolved, unanswered, errors, notes };
}
