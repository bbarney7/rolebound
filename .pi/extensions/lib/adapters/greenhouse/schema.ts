// Greenhouse job-board adapter: reading a posting.
//
// URL parsing, the Job Board API fetch, and the compaction that turns a posting payload
// into the answerable form. Imported through the `../greenhouse` barrel, never directly.
//
// Deliberately free of pi imports (no `@earendil-works/pi-coding-agent`, no typebox) so
// Vitest can import it directly; the pi extension in `.pi/extensions/` is the only place
// that wires these functions to tools.

import { atsFetchInit, greenhouseJobQuestionsUrl } from "../../ats-origin";

// ── HTTP ──

// Copied verbatim from `.pi/extensions/job-gatherer.ts` (the `UA` constant) rather than
// imported: that module pulls in pi-only virtual modules, which Vitest cannot resolve.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Hosts whose `/<board>/jobs/<id>` path carries the board slug itself. */
const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

const BOARD_RE = /^[a-z0-9-]+$/;
const JOB_ID_RE = /^\d+$/;

// ── URL parsing ──

export interface GreenhouseJobRef {
  board: string;
  jobId: string;
  /** True when the board slug was derived from a company name, not read from the URL. */
  boardGuessed: boolean;
}

export type ParseGreenhouseUrlResult = GreenhouseJobRef | { error: string };

export interface ParseGreenhouseUrlOptions {
  /** An exact board slug supplied by the caller; trusted, so `boardGuessed` stays false. */
  boardOverride?: string;
  /** A company name to fall back on; normalized into a slug and flagged as a guess. */
  companyHint?: string;
}

/** Keep an untrusted URL short before it lands in a message the model reads. */
function brief(url: string): string {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}

/** Lowercase a company name and drop everything a board slug cannot contain. */
function slugFromCompany(hint: string): string {
  return hint.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Resolve a job-posting URL to the board slug and job id the Job Board API needs.
 *
 * Three shapes appear in real postings: `boards.greenhouse.io/<board>/jobs/<id>`,
 * `job-boards.greenhouse.io/<board>/jobs/<id>` (both may carry a query string or a
 * trailing slash), and a company-hosted page carrying `?gh_jid=<id>`, where the board
 * must come from the caller.
 */
export function parseGreenhouseUrl(
  url: string,
  opts: ParseGreenhouseUrlOptions = {},
): ParseGreenhouseUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { error: `Not a URL: ${JSON.stringify(brief(url))}. Pass the full job posting URL including https://.` };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  // Shape 1 and 2: the board slug is in the path, so nothing is guessed.
  if (BOARD_HOSTS.has(host) && segments.length === 3 && segments[1] === "jobs") {
    const [board, , jobId] = segments;
    if (!BOARD_RE.test(board)) {
      return { error: `Board slug ${JSON.stringify(board)} in ${brief(url)} is not lowercase letters, digits, and hyphens.` };
    }
    if (!JOB_ID_RE.test(jobId)) {
      return { error: `Job id ${JSON.stringify(jobId)} in ${brief(url)} is not all digits.` };
    }
    return { board, jobId, boardGuessed: false };
  }

  // Shape 3: an embedded posting on the company's own site.
  const ghJid = parsed.searchParams.get("gh_jid");
  if (ghJid === null) {
    return {
      error:
        `Not a Greenhouse job URL: ${brief(url)}. Expected boards.greenhouse.io/<board>/jobs/<id>, ` +
        "job-boards.greenhouse.io/<board>/jobs/<id>, or any URL carrying ?gh_jid=<id>.",
    };
  }
  if (!JOB_ID_RE.test(ghJid)) {
    return { error: `gh_jid=${JSON.stringify(ghJid)} in ${brief(url)} is not all digits.` };
  }

  if (opts.boardOverride !== undefined && opts.boardOverride.trim() !== "") {
    // An override is meant to be the slug itself; normalizing a wrong one into something
    // plausible would hide the mistake behind boardGuessed: false, so only case is fixed.
    const board = opts.boardOverride.trim().toLowerCase();
    if (!BOARD_RE.test(board)) {
      return {
        error: `Board slug ${JSON.stringify(opts.boardOverride)} is not lowercase letters, digits, and hyphens. Use the <board> from boards.greenhouse.io/<board>/jobs/<id>.`,
      };
    }
    return { board, jobId: ghJid, boardGuessed: false };
  }

  if (opts.companyHint !== undefined) {
    const board = slugFromCompany(opts.companyHint);
    if (BOARD_RE.test(board)) return { board, jobId: ghJid, boardGuessed: true };
  }

  return {
    error:
      `${brief(url)} carries gh_jid=${ghJid} but no Greenhouse board slug. Pass the board parameter ` +
      "(the <board> in boards.greenhouse.io/<board>/jobs/<id>, also visible in the page source) " +
      "or a company hint to guess it from.",
  };
}

// ── Schema fetch ──

export type FetchJobSchemaResult =
  | { ok: true; raw: unknown }
  | {
      ok: false;
      error: string;
      status?: number;
      /** The posting is gone from a board slug we know is right. */
      closed?: true;
      /** A 404 on a guessed slug: ask for the real board before calling the job closed. */
      needs_board_slug?: true;
    };

export interface FetchJobSchemaOptions {
  /** Pass through `parseGreenhouseUrl`'s flag; it decides how a 404 is reported. */
  boardGuessed?: boolean;
  /** Injected in tests so the suite never touches the network. */
  fetchImpl?: typeof fetch;
  /**
   * The caller's own cancellation, if it has one — pi's per-tool `AbortSignal`. It is
   * combined with, not substituted for, the request deadline below.
   */
  signal?: AbortSignal;
}

/**
 * How long one Job Board API call may take before it is abandoned.
 *
 * Without a deadline the fetch inherits Node's, which is effectively none: a board that
 * accepts the connection and never answers would hang the tool call, and the model would sit
 * on a turn it cannot end. Twenty seconds is well past the ~1 s this endpoint normally takes
 * and well short of anything a user would wait out.
 */
const FETCH_TIMEOUT_MS = 20_000;

/** Does a parsed body look like Greenhouse's `{"status":404,"error":"Job not found"}`? */
function isJobNotFound(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const body = data as { status?: unknown; error?: unknown };
  return body.status === 404 || (typeof body.error === "string" && /job not found/i.test(body.error));
}

/**
 * Fetch one posting's application schema from the public Job Board API.
 *
 * Mirrors `fetchGreenhouseBoard` in `.pi/extensions/job-gatherer.ts` (same headers, same
 * never-throw contract) but for the single-job endpoint with `?questions=true`, which is
 * what carries the application form.
 */
export async function fetchJobSchema(
  board: string,
  jobId: string,
  opts: FetchJobSchemaOptions = {},
): Promise<FetchJobSchemaResult> {
  // Re-validated here, not just in parseGreenhouseUrl: these two values are interpolated
  // into a URL, and callers can reach this function without going through the parser.
  if (!BOARD_RE.test(board)) {
    return { ok: false, error: `Board slug ${JSON.stringify(board)} is not lowercase letters, digits, and hyphens.` };
  }
  if (!JOB_ID_RE.test(jobId)) {
    return { ok: false, error: `Job id ${JSON.stringify(jobId)} is not all digits.` };
  }

  const boardGuessed = opts.boardGuessed ?? false;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = greenhouseJobQuestionsUrl(board, jobId);

  // A timeout aborts the request, which rejects the fetch — and the catch below turns that
  // into an ordinary `{ ok: false }`, so the never-throw contract holds for a hung board the
  // same way it does for DNS failure.
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal === undefined ? deadline : AbortSignal.any([opts.signal, deadline]);

  let resp: Response;
  try {
    resp = await doFetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal,
      ...atsFetchInit(),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let body: string;
  try {
    body = await resp.text();
  } catch (err) {
    return {
      ok: false,
      status: resp.status,
      error: `could not read the response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let data: unknown;
  let parsedJson = true;
  try {
    data = JSON.parse(body);
  } catch {
    parsedJson = false;
  }

  // Greenhouse answers a missing job with HTTP 404 and that same shape in the body; some
  // intermediaries pass the body through with a 200, so both are treated the same.
  if (resp.status === 404 || (parsedJson && isJobNotFound(data))) {
    if (boardGuessed) {
      return {
        ok: false,
        status: resp.status,
        needs_board_slug: true,
        error:
          `Greenhouse has no job ${jobId} on board ${JSON.stringify(board)}, but that board slug was guessed ` +
          "from the company name, so this is not evidence the job is closed. Call again with the board " +
          "parameter (the <board> in boards.greenhouse.io/<board>/jobs/<id>, also in the page source as " +
          "gh_src or the embed URL), or ask the user for it.",
      };
    }
    return {
      ok: false,
      status: resp.status,
      closed: true,
      error: `Greenhouse has no job ${jobId} on board ${JSON.stringify(board)}: the posting is closed or was removed.`,
    };
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}: ${body.slice(0, 150)}` };
  }
  if (!parsedJson) {
    return {
      ok: false,
      status: resp.status,
      error: `expected JSON from ${url} but got: ${body.slice(0, 150)}`,
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, status: resp.status, error: `expected a JSON object from ${url} but got: ${body.slice(0, 150)}` };
  }

  return { ok: true, raw: data };
}

// ── Schema compaction ──

/**
 * One answerable field of the application form.
 *
 * `id` is the DOM element id Greenhouse renders, taken from `fields[].name` (or, for a
 * demographic question, from its bare numeric `id`). Task 6 turns it into a selector, so
 * it is validated against `ELEMENT_ID_RE` before it is ever emitted — a plain name, a bare
 * numeric demographic id, or a `[]`-suffixed multi-select id; `label`, `options`
 * and `declineOption` are data the model reads and never reach generated code.
 */
export interface CompactQuestion {
  id: string;
  label: string;
  type:
    | "input_text"
    | "textarea"
    | "input_file"
    | "multi_value_single_select"
    | "multi_value_multi_select"
    | "unlisted_select";
  required: boolean;
  /**
   * Option labels, present only on the two select types. Absent on `unlisted_select` by
   * definition: that type exists precisely because the API enumerates no labels for it.
   */
  options?: string[];
  source: "question" | "compliance" | "demographic" | "location";
  /** Set on a `<name>_text` textarea that shadows the file upload of the same question. */
  twinOf?: string;
  /** This board's own wording for "prefer not to answer", when it offers one. */
  declineOption?: string;
}

export interface CompactSchema {
  title: string;
  company: string;
  questions: CompactQuestion[];
  /** Gaps and drops the model has to know about; never description HTML. */
  notes: string[];
}

/**
 * An id safe to interpolate into a selector. Decision 9: a field failing this is dropped.
 * Exported for `answers.ts`, which enforces the same rule before building a selector; not
 * part of the adapter's public surface, so the `../greenhouse` barrel does not re-export it.
 *
 * Greenhouse names a multi_value_multi_select field `question_<n>[]` — the brackets are part
 * of the DOM id (`<input id="question_67918863[]">`, `<p id="question_67918863[]-error">`) —
 * so an optional trailing `[]` is admitted; `elementRef` in answers.ts reaches such an id
 * through the attribute form, since `#question_67918863[]` is not a valid id selector.
 */
export const ELEMENT_ID_RE = /^[A-Za-z0-9_-]+(?:\[\])?$/;

/**
 * Wordings boards use for "prefer not to answer" on a `questions[]` or `compliance[]`
 * select, which carry no machine-readable decline flag. "want" is in the list because
 * anthropic's `disability_status` offers "I do not want to answer" and nothing else that
 * reads as a decline; without it that question would have no `declineOption` at all.
 */
const DECLINE_RE = /decline|prefer not|(?:don[’']t|do not|choose not)\s+(?:to\s+)?(?:wish|want|answer|say)/i;

const FIELD_TYPES = new Set<string>([
  "input_text",
  "textarea",
  "input_file",
  "multi_value_single_select",
  "multi_value_multi_select",
]);

/**
 * Demographic questions carry their type on the question rather than on a field, and
 * boards spell the two select types either the long `questions[]` way (what the amplitude
 * fixture uses) or the short way. Both normalize onto the same union so Task 6's
 * `selectorFor` only ever sees the long spelling.
 */
const DEMOGRAPHIC_TYPES: Record<string, CompactQuestion["type"] | undefined> = {
  single_select: "multi_value_single_select",
  multi_select: "multi_value_multi_select",
  multi_value_single_select: "multi_value_single_select",
  multi_value_multi_select: "multi_value_multi_select",
};

const TWIN_SUFFIX = "_text";

// Every helper below narrows untrusted network JSON; none of them ever throws. The two that
// `answers.ts` also needs are exported for it; like `clip`, they are adapter internals, so
// the `../greenhouse` barrel does not re-export them.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Ids arrive as strings in `fields[].name` and as bare numbers on demographic questions. */
function asId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asFieldType(value: unknown): CompactQuestion["type"] | null {
  return typeof value === "string" && FIELD_TYPES.has(value)
    ? (value as CompactQuestion["type"])
    : null;
}

/** Keep an untrusted string short before it lands in a note or error the model reads. */
export function clip(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

function droppedIdNote(name: string, label: string): string {
  const where = label === "" ? "" : ` on question \`${clip(label)}\``;
  return `Dropped field \`${clip(name)}\`${where}: an id must match ${ELEMENT_ID_RE.source} to be used as a selector, so this field is not answerable.`;
}

function droppedTypeNote(id: string, type: unknown): string {
  return `Dropped field \`${id}\`: unsupported field type \`${clip(String(type))}\`.`;
}

/** Option labels, in payload order. Never `values[].value`, which is a number here and a string on compliance. */
function optionLabels(options: Array<Record<string, unknown>>): string[] {
  return options.map((option) => asText(option.label)).filter((label) => label !== "");
}

function records(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * Flatten `questions[]` or `compliance[].questions[]`, which share a shape: a labelled
 * question owning one or more `fields[]`, each of which is its own DOM element.
 */
function compactFieldQuestions(
  entries: Array<Record<string, unknown>>,
  source: "question" | "compliance",
  out: CompactQuestion[],
  notes: string[],
): void {
  for (const entry of entries) {
    const label = asText(entry.label);
    const required = entry.required === true;
    // Ids already emitted for THIS question, so a twin only ever points at its own parent.
    const siblings = new Set<string>();

    for (const field of records(entry.fields)) {
      const id = asId(field.name);
      if (!ELEMENT_ID_RE.test(id)) {
        notes.push(droppedIdNote(id, label));
        continue;
      }
      const type = asFieldType(field.type);
      if (type === null) {
        notes.push(droppedTypeNote(id, field.type));
        continue;
      }

      const question: CompactQuestion = { id, label, type, required, source };
      const options = optionLabels(records(field.values));
      if (options.length > 0) {
        question.options = options;
        const decline = options.find((option) => DECLINE_RE.test(option));
        if (decline !== undefined) question.declineOption = decline;
      }
      // "Resume/CV" is one question with two elements: an upload and a paste-the-text
      // textarea named `<upload>_text`. Both are answerable, but only one at a time.
      if (id.endsWith(TWIN_SUFFIX)) {
        const parent = id.slice(0, -TWIN_SUFFIX.length);
        if (siblings.has(parent)) question.twinOf = parent;
      }
      siblings.add(id);
      out.push(question);
    }
  }
}

/**
 * Flatten `demographic_questions`, an object (not an array) whose `questions[]` differ
 * from `questions[]` proper: the id is a bare number, the type sits on the question, the
 * options live under `answer_options[]`, and one of them is flagged `decline_to_answer`.
 */
function compactDemographicQuestions(
  container: unknown,
  out: CompactQuestion[],
  notes: string[],
): void {
  const block = asRecord(container);
  if (block === null) return;

  for (const entry of records(block.questions)) {
    const id = asId(entry.id);
    const label = asText(entry.label);
    if (!ELEMENT_ID_RE.test(id)) {
      notes.push(droppedIdNote(id, label));
      continue;
    }
    const type = DEMOGRAPHIC_TYPES[asText(entry.type)];
    if (type === undefined) {
      notes.push(droppedTypeNote(id, entry.type));
      continue;
    }

    const question: CompactQuestion = {
      id,
      label,
      type,
      required: entry.required === true,
      source: "demographic",
    };
    const answers = records(entry.answer_options);
    const options = optionLabels(answers);
    if (options.length > 0) question.options = options;
    const declined = answers.find((answer) => answer.decline_to_answer === true);
    if (declined !== undefined) {
      const declineLabel = asText(declined.label);
      if (declineLabel !== "") question.declineOption = declineLabel;
    }
    out.push(question);
  }
}

/**
 * The `Location (City)` control.
 *
 * It is `unlisted_select` rather than `multi_value_single_select` because the Job Board
 * API does not enumerate its option labels: there is no list to validate an answer
 * against, and the geocoder answers a city name with a fuller one ("San Francisco" →
 * "San Francisco, California, United States").
 *
 * `location_questions` names the field `location` and types it `input_text`; the rendered
 * control is `input#candidate-location[role=combobox]` inside `div.select__control`, fed
 * by `api-geocode-earth-proxy.greenhouse.io`. The id here is the DOM's, because that is
 * what a selector needs. Its two siblings, `longitude` and `latitude`, are `input_hidden`
 * and are not in the DOM at all — react-select holds them in state — so they are dropped.
 *
 * There is no separate address-country question synthesized here. The page also renders
 * `input#country[role=combobox]`, but that control is the phone widget's dial-code
 * selector, not an address field — its only "United States" option is literally
 * `United States +1`, and picking it reformats the `phone` field. An earlier version of
 * this adapter synthesized a `country` question aimed at that control; answering a
 * dial-code selector with a country name is wrong on its own terms, and it corrupted
 * `phone` on every board, so the synthesis was removed. The control is left alone.
 */
function compactLocationQuestions(raw: unknown, out: CompactQuestion[], notes: string[]): void {
  for (const entry of records(raw)) {
    for (const field of records(entry.fields)) {
      if (asText(field.name) !== "location" || asText(field.type) !== "input_text") continue;
      out.push({
        id: "candidate-location",
        label: "Location (City)",
        type: "unlisted_select",
        required: entry.required === true,
        source: "location",
      });
      notes.push(
        "Location (City) is a type-ahead over Greenhouse's geocoder: answer it with a city " +
          "name and the form stores the fuller wording it resolves to.",
      );
      return;
    }
  }
}

/**
 * Reduce a `fetchJobSchema` payload to the answerable form, small enough to hand the
 * model whole.
 *
 * `raw` is untrusted network JSON, so every level is narrowed defensively and anything
 * unrecognized is skipped with a note rather than thrown on. Dropped on the floor:
 * `content` (the job-description HTML), `data_compliance`, and every `description` — the
 * consent copy and the EEOC preambles run to kilobytes of escaped HTML and answer nothing.
 */
export function compactSchema(raw: unknown): CompactSchema {
  const root = asRecord(raw);
  if (root === null) return { title: "", company: "", questions: [], notes: [] };

  const questions: CompactQuestion[] = [];
  const notes: string[] = [];

  compactFieldQuestions(records(root.questions), "question", questions, notes);
  // `compliance` is null on boards that ask no EEOC questions, and an entry that carries
  // only a preamble has an empty `questions[]`, which contributes nothing on its own.
  for (const entry of records(root.compliance)) {
    compactFieldQuestions(records(entry.questions), "compliance", questions, notes);
  }
  // `demographic_questions` is null on boards that run no self-ID survey.
  compactDemographicQuestions(root.demographic_questions, questions, notes);

  compactLocationQuestions(root.location_questions, questions, notes);

  if (questions.some((question) => question.type === "input_file")) {
    notes.push(
      "A file upload, the resume field included, expects an absolute path on disk, not a relative one.",
    );
  }

  return { title: asText(root.title), company: asText(root.company_name), questions, notes };
}
