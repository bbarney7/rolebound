/**
 * ATS Adapters — Pi Extension
 *
 * Structured adapters for job boards whose application form can be read from an API
 * instead of perceived through the browser. Today that is Greenhouse: instead of
 * snapshotting and filling the form field by field, the model fetches a compact schema,
 * sends back one answers object, and runs three generated Playwright scripts through the
 * `job-playwright` MCP — fill, submit, security code.
 *
 * Gated by `PI_JOBS_ATS_ADAPTERS` (see `lib/config.ts`). The switch is read as the very
 * first statement of the factory, before any `registerTool`, so with the adapter off this
 * file registers nothing and contributes nothing to the system prompt — the off path is
 * structurally identical to a checkout without it (Decision 2).
 *
 * All adapter guidance rides on the tool definitions' `promptSnippet` / `promptGuidelines`
 * (Decision 3). There is deliberately NO `before_agent_start` handler here: the legacy
 * prompt in `job-applier.ts` is untouched, and nothing can leak into the system prompt
 * while the switch is off.
 *
 * Nothing about a particular applicant is hardcoded. Answers come from `profile.md` by way
 * of the model; this file only checks them against the board's own schema.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { adapterEnabled, isSafeSlug } from "./lib/config";
import { isInWorkspace, wsPath } from "./lib/workspace";
import {
  buildAnswerTemplate,
  compactSchema,
  fetchJobSchema,
  generateFillScript,
  generateOtpScript,
  generateSubmitScript,
  parseGreenhouseUrl,
  validateAnswers,
} from "./lib/adapters/greenhouse";
import type { CompactSchema, ResolvedAnswer } from "./lib/adapters/greenhouse";
import { evaluateWorkspaceToolGate } from "./submission-guard";

// ── Tool result helpers ──

/** Every tool answers with one text block plus the structured form of the same thing. */
function reply(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

async function deleteStaleGreenhouseScripts(slug: string): Promise<void> {
  for (const kind of ["submit", "otp"] as const) {
    await fs.unlink(wsPath(".pi-jobs", "scripts", `${slug}-${kind}.js`)).catch(() => {});
  }
}

async function gateGreenhousePrep(
  cwd: string,
  toolName: "greenhouse_prepare_submit" | "greenhouse_prepare_otp",
  slug: string,
): Promise<string | null> {
  const gate = await evaluateWorkspaceToolGate(cwd, toolName, { slug });
  if (gate.allow) return null;
  await deleteStaleGreenhouseScripts(slug);
  return gate.reason ?? `${gate.code}: submission guard refused this call`;
}

/** A failure the model has to read and act on; never thrown, so the turn keeps its shape. */
function fail(text: string, extra: Record<string, unknown> = {}) {
  return reply(text, { ok: false, error: text, ...extra });
}

/**
 * A globally-installed copy of these extensions must stay inert in unrelated projects, the
 * same way the `job-applier` hook and commands do. This is a new gate for tools — the
 * existing tools do not have one — because these four write files into the workspace.
 */
const OUTSIDE_WORKSPACE =
  "The ATS adapters only work in the job-applier workspace. pi was started from somewhere " +
  "else, so this tool is inert here. Restart pi from the workspace root.";

/** Keep an untrusted string short before it lands in a message the model reads. */
function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function badSlug(slug: string): string {
  return (
    `\`${clip(slug)}\` is not a usable slug. Pass the queue file's basename — letters, ` +
    `digits, ".", "_" and "-" only, and no "..".`
  );
}

// ── Schema loading ──

type LoadedSchema =
  | { ok: true; board: string; jobId: string; schema: CompactSchema }
  | { ok: false; text: string; details: Record<string, unknown> };

/**
 * Resolve a posting URL to its compacted application form.
 *
 * Both `greenhouse_get_form` and `greenhouse_prepare_fill` go through this. The fill tool
 * re-fetches rather than accepting a schema parameter on purpose (Decision 9): the schema
 * decides which ids become selectors, so it must come from Greenhouse on every call and
 * never from the model. The payload is small and the request is one GET.
 */
async function loadSchema(url: string, board?: string, companyHint?: string): Promise<LoadedSchema> {
  const ref = parseGreenhouseUrl(url, { boardOverride: board, companyHint });
  if ("error" in ref) return { ok: false, text: ref.error, details: { ok: false, error: ref.error } };

  const fetched = await fetchJobSchema(ref.board, ref.jobId, { boardGuessed: ref.boardGuessed });
  if (!fetched.ok) {
    // The two 404 flavours mean opposite things, and only one of them is a `blocked`.
    const advice =
      fetched.closed === true
        ? "\n\nThe posting is gone. Do not retry and do not open the page: call " +
          "`update_application_state` with status `blocked` and `block_reason: \"job closed\"`, " +
          "close the attempt, and move on to the next job."
        : fetched.needs_board_slug === true
          ? "\n\nThis is NOT evidence the job is closed. Call `greenhouse_get_form` again with " +
            "`board` set to the real slug — it appears in the posting page's source as " +
            "`boards.greenhouse.io/<board>` or in a `gh_src` parameter — or ask the user for it. " +
            "Do NOT mark the application blocked."
          : "";
    return {
      ok: false,
      text: `Could not read the Greenhouse application form: ${fetched.error}${advice}`,
      details: {
        ok: false,
        error: fetched.error,
        status: fetched.status ?? null,
        closed: fetched.closed === true,
        needs_board_slug: fetched.needs_board_slug === true,
      },
    };
  }

  return { ok: true, board: ref.board, jobId: ref.jobId, schema: compactSchema(fetched.raw) };
}

// ── Script files ──

const SCRIPTS_DIR = wsPath(".pi-jobs", "scripts");

/**
 * Resolve one file under `<workspace>/.pi-jobs/scripts/` and prove it stayed there.
 *
 * run_code refuses a `filename` outside pi's cwd (Decision 10), which is what makes this
 * directory the only usable one. `slug` reaches here from the model, so the resolved target
 * is re-checked against the directory even though `isSafeSlug` already rejected traversal —
 * the path check is the guarantee, the slug rule is the friendly error. The sidecar goes
 * through the same check as the scripts, because it is named after the same slug.
 */
function inScriptsDir(name: string): string {
  const dir = path.resolve(SCRIPTS_DIR);
  const target = path.resolve(path.join(dir, name));
  if (!target.startsWith(dir + path.sep)) {
    throw new Error(`Refusing to touch a file outside ${dir}.`);
  }
  return target;
}

/** Write one generated script under `<workspace>/.pi-jobs/scripts/`. */
async function writeScript(slug: string, kind: string, source: string): Promise<string> {
  const target = inScriptsDir(`${slug}-${kind}.js`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, "utf8");
  return target;
}

// ── The job sidecar (Ruling P) ──

/**
 * What `greenhouse_prepare_fill` records beside the fill script so the two tools that follow
 * it know which posting these scripts belong to.
 *
 * Every generated script's first act is to check `page.url()` against its job id, which means
 * every generator needs one — and `prepare_submit` / `prepare_otp` take only a slug, because
 * asking the model for the URL again is asking it to be the source of truth for which job is
 * about to be submitted. The sidecar closes that gap: the id is written once, by the tool
 * that fetched the schema, and read back from disk.
 */
interface JobSidecar {
  url: string;
  board: string;
  jobId: string;
}

const BOARD_RE = /^[a-z0-9-]+$/;
const JOB_ID_RE = /^\d+$/;

async function writeSidecar(slug: string, ref: JobSidecar): Promise<void> {
  const target = inScriptsDir(`${slug}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(ref, null, 2)}\n`, "utf8");
}

/**
 * Read one back. Validated as strictly as anything off the network: the file lives in a
 * gitignored directory a previous run wrote, and its job id is about to become the only
 * thing standing between a submit script and the wrong posting.
 */
async function readSidecar(slug: string): Promise<JobSidecar | { error: string }> {
  const missing =
    `No job record for \`${clip(slug)}\`. Call greenhouse_prepare_fill first: it fetches the ` +
    "schema, writes the fill script, and records which posting these scripts belong to. " +
    "The submit and security-code scripts refuse to run on any other page.";
  let raw: string;
  try {
    raw = await fs.readFile(inScriptsDir(`${slug}.json`), "utf8");
  } catch {
    return { error: missing };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `The job record for \`${clip(slug)}\` is not readable JSON. ${missing}` };
  }
  const record = parsed as Partial<JobSidecar> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.url !== "string" ||
    typeof record.board !== "string" ||
    typeof record.jobId !== "string" ||
    !BOARD_RE.test(record.board) ||
    !JOB_ID_RE.test(record.jobId)
  ) {
    return { error: `The job record for \`${clip(slug)}\` is malformed. ${missing}` };
  }
  return { url: record.url, board: record.board, jobId: record.jobId };
}

/** Direct pi 1.0.4 MCP tool name for generated Greenhouse scripts (PJR-15 T1). */
export function browserRunCodeCallLine(scriptPath: string): string {
  return `mcp__job_playwright__browser_run_code_unsafe({ filename: ${JSON.stringify(scriptPath)} })`;
}

function callLine(scriptPath: string): string {
  return browserRunCodeCallLine(scriptPath);
}

/** One resolved answer as the model reads it back before anything is submitted (Decision 4). */
function answerLine(a: ResolvedAnswer): string {
  const flat = Array.isArray(a.value) ? a.value.join(" | ") : a.value;
  const oneLine = flat.replace(/\s+/g, " ").trim();
  const value = oneLine.length > 300 ? `${oneLine.slice(0, 300)}… (${oneLine.length} chars)` : oneLine;
  return `${a.id} — ${a.label} — ${value}`;
}

function notesSection(notes: string[]): string {
  return notes.length === 0 ? "" : `\n\n### Notes\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

// ── Extension ──

export default function atsAdaptersExtension(pi: ExtensionAPI) {
  // Decision 2: the switch is read before anything is registered, so with the adapter off
  // this extension is a no-op and the system prompt is byte-identical to main's.
  if (!adapterEnabled("greenhouse")) return;

  pi.registerTool({
    name: "greenhouse_get_form",
    label: "Greenhouse: Get Form",
    description:
      "Read a Greenhouse posting's application form from the Job Board API and return it as a compact schema " +
      "plus a blank answers object keyed by the schema's own question ids. Every question's label, type, " +
      "required flag, options and decline wording are already on the schema question, so the two together are " +
      "all that is needed to answer it. Accepts boards.greenhouse.io/<board>/jobs/<id>, " +
      "job-boards.greenhouse.io/<board>/jobs/<id>, or any URL carrying ?gh_jid=<id> (pass board or company_hint " +
      "for those). Returns no job-description HTML.",
    promptSnippet:
      "greenhouse_get_form: a Greenhouse posting's form as a compact schema + answers.",
    promptGuidelines: [
      "Greenhouse URL (boards.greenhouse.io, job-boards.greenhouse.io, or ?gh_jid=): (1) browser_navigate to the posting, (2) greenhouse_get_form, (3) greenhouse_prepare_fill, (4) run its script and read filled[], (5) greenhouse_prepare_submit. Never fill the form field by field.",
      'Answers key by schema id, from profile.md (Identity, "## Q&A bank", "### EEO / self-identification defaults") and match_resume (resume_path, address). EEO answers are "__decline__" or the profile default, silently; never a stop trigger.',
      "A required free-text question that is company- or role-specific (e.g. 'Why <Company>?') is a stop-and-ask per the Stop and ask triggers in your instructions — leave it empty in `answers` and report it to the user; do not compose it.",
      'A closed job: status blocked, block_reason "job closed". A needs-board-slug error: retry with board (page source: boards.greenhouse.io/<board> or gh_src) or ask the user; never blocked.',
      "On a `?gh_jid=` / company-careers URL pass `company_hint` (the queue file's `company`); `discover_greenhouse_board` is a gatherer tool, not part of applying. The form may sit inside a Greenhouse iframe — the scripts handle that; never drive it by hand with frameLocator.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The job posting URL from the queue file's frontmatter." }),
      board: Type.Optional(
        Type.String({ description: "Board slug, when the URL does not carry one (the <board> in boards.greenhouse.io/<board>/jobs/<id>)." }),
      ),
      company_hint: Type.Optional(
        Type.String({ description: "Company name to guess the board slug from; a 404 on a guess asks for the real slug rather than calling the job closed." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isInWorkspace(ctx.cwd)) return fail(OUTSIDE_WORKSPACE);

      const loaded = await loadSchema(params.url, params.board, params.company_hint);
      if (!loaded.ok) return reply(loaded.text, loaded.details);

      const { notes, ...schema } = loaded.schema;
      const answer_template = buildAnswerTemplate(loaded.schema);
      // Ruling Q: the model-facing text carries the schema and the blank answers object and
      // nothing else. `hints` is a second copy of every question's label, type, required
      // flag, options and decline wording — the schema questions already say all of that —
      // so sending both roughly doubled this payload for no information. It stays in
      // `details`, where a programmatic caller can still reach it without spending context.
      return reply(JSON.stringify({ schema, answers: answer_template.answers, notes }), {
        ok: true,
        board: loaded.board,
        job_id: loaded.jobId,
        schema: loaded.schema,
        answer_template,
      });
    },
  });

  pi.registerTool({
    name: "greenhouse_prepare_fill",
    label: "Greenhouse: Prepare Fill",
    description:
      "Check an answers object against the posting's own schema (re-fetched here, never taken from the caller) and, " +
      "if nothing is missing or wrong, write the browser script that fills the form. Pass the same board / company_hint " +
      "you passed to greenhouse_get_form, since the schema is fetched again here. Returns the resolved answers to read " +
      "before submitting and the exact mcp__job_playwright__browser_run_code_unsafe call that runs the script. Writes nothing while anything is unanswered " +
      "or in error.",
    promptSnippet:
      "greenhouse_prepare_fill: check answers against that schema, write the fill script; same board/company_hint as get_form.",
    promptGuidelines: [
      "prepare_fill writes no script while anything is unanswered or in error: fill the gap from profile.md or stop and ask per the Stop and ask triggers in your instructions, never guess. Read every filled[] value and clear skipped[]/validation_errors[] before submitting.",
      'A `reason` that starts with `form not found`, or is `form not settled` → `browser_navigate` to the posting URL again, `browser_wait_for` 3 s, re-run the same script once (it is already on disk); twice → stop and ask. `reason: "deadline"` → re-run the same script once (re-typing a filled field is harmless); a second `deadline` → stop and ask.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The same posting URL passed to greenhouse_get_form." }),
      board: Type.Optional(
        Type.String({ description: "The same board slug passed to greenhouse_get_form; required on a ?gh_jid= URL, which carries no slug of its own." }),
      ),
      company_hint: Type.Optional(
        Type.String({ description: "The same company hint passed to greenhouse_get_form, when the board slug was guessed from it." }),
      ),
      slug: Type.String({ description: "The queue file's basename; names the generated script." }),
      answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
        description:
          'Question id → answer. A string for everything except a multi_value_multi_select, which takes a list. Use "__decline__" for a decline.',
      }),
      resume_path: Type.String({ description: "Absolute path to the resume PDF, as returned by match_resume." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isInWorkspace(ctx.cwd)) return fail(OUTSIDE_WORKSPACE);
      if (!isSafeSlug(params.slug)) return fail(badSlug(params.slug));

      const loaded = await loadSchema(params.url, params.board, params.company_hint);
      if (!loaded.ok) return reply(loaded.text, loaded.details);

      const checked = validateAnswers(loaded.schema, params.answers);
      if (!checked.ok) {
        // Decision 4 / CLAUDE.md: a gap is handed back for the stop-and-ask flow, not
        // papered over. No script is written, so nothing can be run half-answered.
        const sections: string[] = [
          `No fill script was written for \`${params.slug}\`: the answers are not complete.`,
        ];
        if (checked.unanswered.length > 0) {
          const missing = checked.unanswered.map((id) => {
            const hint = loaded.schema.questions.find((q) => q.id === id);
            return `- ${id} — ${hint === undefined ? "(not in the schema)" : hint.label}`;
          });
          sections.push(`### Required, unanswered\n${missing.join("\n")}`);
        }
        if (checked.errors.length > 0) {
          sections.push(`### Errors\n${checked.errors.map((e) => `- ${e}`).join("\n")}`);
        }
        // The notes explain several of the errors above — "the twin was dropped because the
        // file field is answered too" reads as an unexplained gap without them — so the
        // failure path carries them for the same reason the success path does.
        if (checked.notes.length > 0) {
          sections.push(`### Notes\n${checked.notes.map((n) => `- ${n}`).join("\n")}`);
        }
        sections.push(
          "Answer these from profile.md and call greenhouse_prepare_fill again, or stop and ask per the Stop and ask triggers in your instructions. Do not guess.",
        );
        return reply(sections.join("\n\n"), {
          ok: false,
          unanswered: checked.unanswered,
          errors: checked.errors,
          notes: checked.notes,
        });
      }

      // Decision 10: the upload happens through page.setInputFiles inside run_code, which
      // is not root-restricted, so an absolute resume path outside the repo is used as-is
      // — neither rejected nor copied. Only the script file has to live in the workspace.
      const resumePath = path.resolve(ctx.cwd, params.resume_path);
      try {
        const stat = await fs.stat(resumePath);
        if (!stat.isFile()) return fail(`Resume path ${resumePath} is not a file.`);
      } catch {
        return fail(`Resume path ${resumePath} does not exist. Call match_resume for the absolute path, and stop and ask if the file is missing.`);
      }

      let scriptPath: string;
      try {
        scriptPath = await writeScript(
          params.slug,
          "fill",
          generateFillScript(checked.resolved, resumePath, loaded.jobId),
        );
        // Written after the script, so a slug that could not take a script never leaves a
        // record claiming it did. Ruling P: this is what prepare_submit and prepare_otp read.
        await writeSidecar(params.slug, { url: params.url, board: loaded.board, jobId: loaded.jobId });
      } catch (err) {
        return fail(`Could not write the fill script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const text =
        `Fill script ready for \`${params.slug}\` — ${checked.resolved.length} answer(s), resume ${resumePath}.\n\n` +
        `### Answers that will be typed\n${checked.resolved.map(answerLine).join("\n")}` +
        notesSection([...loaded.schema.notes, ...checked.notes]) +
        `\n\n### Run it\n${callLine(scriptPath)}\n\n` +
        "### What comes back\n" +
        "A `### Result` block holding JSON:\n" +
        '{"ok":true,"filled":[{"id":"…","label":"…","value":"…"}],"skipped":[{"id":"…","label":"…","reason":"…"}],"validation_errors":[{"id":"…","label":"…","error":"…"}],"frame":null}\n' +
        "`frame` names the Greenhouse iframe the script worked in, and is null on a Greenhouse-hosted board. The script " +
        "settles on a stable, hydrated form before it types and reads every text value back off the page afterwards, so " +
        "`filled` is what the form is holding, not what was sent to it — except on a `deadline` result, where the " +
        "read-back may not have reached every text field.\n" +
        "Read every `filled` value before you submit. Anything in `skipped` or `validation_errors` is still unfilled — " +
        "fix it with the job-playwright browser tools, or stop and ask, before calling greenhouse_prepare_submit. " +
        'A `skipped` reason of "not on page" means the schema names a field this board does not render: leave it if the ' +
        "schema calls it optional, otherwise fill it with the browser tools or stop and ask. A `[]` question the " +
        "board renders as a checkbox group is checked by label, so it no longer comes back `not on page`. " +
        "`candidate-location` is a type-ahead over Greenhouse's geocoder: `filled[]` reports the fuller wording it " +
        "resolved to (`San Francisco` becomes `San Francisco, California, United States`) — read it, and stop and " +
        "ask if it resolved to the wrong place. There is no `country` question: the page's `input#country` is the " +
        "phone widget's dial-code selector, not an address field, and is left alone. A `validation_errors` error " +
        'of "value did not stick" means the script typed that field, read it back, retried once, and the value still did ' +
        "not hold: fill it with the browser tools and read it back before submitting.\n" +
        'An error of "selected \'\' instead of …" on a select means the menu had not opened in time to be typed ' +
        "into: run this same script once more before reaching for the browser tools — re-running it is safe on " +
        "every field type.\n" +
        'An error of "upload not confirmed" means the script attached the file up to three times — it attaches files ' +
        "last, after every other field, because Greenhouse only accepts an upload once its own setup request has " +
        "returned — and never saw the page confirm it; the text after the colon, when there is one, is the page's own " +
        "upload error. Run this same script once more (re-attaching is harmless; every other field is re-typed or " +
        "re-selected to the same value, and a select that already holds its value is left as it is) and stop and ask " +
        "if it fails again. Never reach for browser_file_upload: it only accepts files under the workspace, and the " +
        "resume lives outside it. When a retry does land, Greenhouse can leave the error it showed for the failed " +
        "attach on screen beside the attached file: the fill's own read-back is the evidence that the file is " +
        "there, not that stale message, so do not chase it.\n" +
        '`ok:false` with `reason: "form not found"` (no application form in the page or in any of its frames) or ' +
        '"form not settled" (the form was there but kept remounting) lists every frame the page was showing in `frames`. ' +
        "Both are handled the same way: browser_navigate to the posting URL again, browser_wait_for 3 s, then run this " +
        "same script once more — it is already on disk. A second failure is a stop and ask.\n" +
        '`reason: "deadline"` means the script ran out of its 30 s budget: the fields it never reached carry "out of ' +
        'time" in `skipped` or in `validation_errors`. It can also mean the read-back was cut short, in which case the ' +
        'text entries past the cut-off say nothing at all — so on `deadline`, treat every `filled` text value as ' +
        "unconfirmed. Run the same script again — re-typing a field that is already filled is harmless — and stop and " +
        "ask on a second `deadline`.\n" +
        `A \`reason\` of "wrong page: expected job ${loaded.jobId}" means the tab moved: browser_navigate back to the ` +
        "posting and run the script again. Nothing was typed.";

      return reply(text, {
        ok: true,
        slug: params.slug,
        script: scriptPath,
        call: callLine(scriptPath),
        resume_path: resumePath,
        board: loaded.board,
        job_id: loaded.jobId,
        resolved: checked.resolved,
        notes: [...loaded.schema.notes, ...checked.notes],
      });
    },
  });

  pi.registerTool({
    name: "greenhouse_prepare_submit",
    label: "Greenhouse: Prepare Submit",
    description:
      "Write the browser script that clicks Submit application on a filled Greenhouse form and reports what the page " +
      "did next. Requires greenhouse_prepare_fill to have run for this slug: the script refuses to click unless the " +
      "browser is on the posting that call recorded. Returns the exact mcp__job_playwright__browser_run_code_unsafe call that runs it and what each " +
      "reported state means.",
    promptSnippet:
      "greenhouse_prepare_submit: write the submit script; its state says what to do.",
    promptGuidelines: [
      'Submit states: captcha - handle per the CAPTCHA section of your instructions (solver workflow if present, else stop with block_reason "captcha"); validation_errors - fix or stop and ask; otp_required - fetch the code, then greenhouse_prepare_otp; submitted - run the checklist.',
      'The reCAPTCHA badge and a Submit button greyed out while submitting are not CAPTCHAs. A visible challenge or \'press and hold\' is: follow your CAPTCHA-handling section if you have one, else stop with `block_reason: "captcha"`. Never record a CAPTCHA as submitted.',
      'Security code: use an available email integration if configured, or call request_manual_verification({kind:"otp", ...}) so the user can paste the code. Gmail CLI/browser mail is optional, never required.',
      "After submitted: screenshot; update_application_state (confirmation_source, confirmation_evidence, screenshot or screenshot_error); complete_application; summary.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "The queue file's basename; names the generated script." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isInWorkspace(ctx.cwd)) return fail(OUTSIDE_WORKSPACE);
      if (!isSafeSlug(params.slug)) return fail(badSlug(params.slug));

      const blocked = await gateGreenhousePrep(ctx.cwd, "greenhouse_prepare_submit", params.slug);
      if (blocked) return fail(blocked);

      const job = await readSidecar(params.slug);
      if ("error" in job) return fail(job.error);

      let scriptPath: string;
      try {
        scriptPath = await writeScript(params.slug, "submit", generateSubmitScript(job.jobId));
      } catch (err) {
        return fail(`Could not write the submit script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const text =
        `Submit script ready for \`${params.slug}\` — job ${job.jobId} on board ${job.board}. ` +
        "Read the fill result before running it.\n\n" +
        `### Run it\n${callLine(scriptPath)}\n\n` +
        "### What comes back\n" +
        'A `### Result` block holding `{"state":…}`:\n' +
        "- `otp_required` — Greenhouse emailed an 8-character security code and swapped in the code boxes. Retrieve the code, then call greenhouse_prepare_otp.\n" +
        "- `submitted` — the application is in. Run the post-submit checklist: confirmation screenshot, update_application_state (confirmation_source, confirmation_evidence, screenshot), complete_application, one-line summary.\n" +
        "- `validation_errors` — `validation_errors[]` names each one: `id` is the field's own id (a multi-select's ends in `[]`), `label` its visible label when the page exposes one, `error` the message Greenhouse shows beside it. Fix them with greenhouse_prepare_fill's script if the value is wrong or missing (re-running it is safe), otherwise with the job-playwright browser tools, then run this script again — or stop and ask per the Stop and ask triggers in your instructions.\n" +
        "- `captcha` — a real challenge is up. If your instructions carry a CAPTCHA-handling section, run it (detect → solve_captcha → inject → re-run this submit script). If they do not, stop: update_application_state blocked / \"captcha\" and hand the browser back. Never record it as submitted.\n" +
        "- `unknown` — up to 40 s passed with nothing recognisable; `detail` carries the page title and the head of its text. Look with browser_snapshot before deciding.\n" +
        `- \`error\` — the script itself failed; \`detail\` says how. A detail of "wrong page: expected job ${job.jobId}" means the tab is not on this posting: nothing was clicked, so browser_navigate back and run it again.`;

      return reply(text, {
        ok: true,
        slug: params.slug,
        script: scriptPath,
        call: callLine(scriptPath),
        board: job.board,
        job_id: job.jobId,
      });
    },
  });

  pi.registerTool({
    name: "greenhouse_prepare_otp",
    label: "Greenhouse: Prepare OTP",
    description:
      "Write the browser script that types Greenhouse's emailed security code into the code boxes, reads them back, and " +
      "re-submits the application. Requires greenhouse_prepare_fill to have run for this slug, the same way " +
      "greenhouse_prepare_submit does. Returns the exact mcp__job_playwright__browser_run_code_unsafe call that runs it.",
    promptSnippet:
      "greenhouse_prepare_otp: write the script that enters the emailed security code.",
    promptGuidelines: [
      "prepare_otp takes the code verbatim (4-10 letters/digits); the script fills the boxes, reads back, re-submits. captcha means stop.",
      "This replaces the legacy per-box `browser_type` OTP procedure; never type the code by hand when this tool is available.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "The queue file's basename; names the generated script." }),
      code: Type.String({ description: "The security code from the email — 4-10 letters and digits, verbatim." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isInWorkspace(ctx.cwd)) return fail(OUTSIDE_WORKSPACE);
      if (!isSafeSlug(params.slug)) return fail(badSlug(params.slug));

      const blocked = await gateGreenhousePrep(ctx.cwd, "greenhouse_prepare_otp", params.slug);
      if (blocked) return fail(blocked);

      if (!/^[A-Za-z0-9]{4,10}$/.test(params.code)) {
        return fail(
          `\`${clip(params.code, 20)}\` is not a Greenhouse security code: it must be 4-10 letters and digits, with no spaces or punctuation. Re-read the email — the code is in the HTML body, so the gmail CLI may show it empty.`,
        );
      }

      const job = await readSidecar(params.slug);
      if ("error" in job) return fail(job.error);

      let scriptPath: string;
      try {
        scriptPath = await writeScript(params.slug, "otp", generateOtpScript(params.code, job.jobId));
      } catch (err) {
        return fail(`Could not write the OTP script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const text =
        `Security-code script ready for \`${params.slug}\` — job ${job.jobId} on board ${job.board}.\n\n` +
        `### Run it\n${callLine(scriptPath)}\n\n` +
        "### What comes back\n" +
        'A `### Result` block holding `{"state":…}`: `submitted` — done, run the post-submit checklist; ' +
        "`captcha` — a real challenge is up: run the CAPTCHA-handling section of your instructions if you have one, else stop (status `blocked`, `block_reason: \"captcha\"`) and hand the browser back — never record it as submitted; " +
        "`error` — `detail` says what went wrong (a code the boxes would not take, no security-code group on the page, " +
        `or "wrong page: expected job ${job.jobId}" — the tab moved, so navigate back and run it again).`;

      return reply(text, {
        ok: true,
        slug: params.slug,
        script: scriptPath,
        call: callLine(scriptPath),
        board: job.board,
        job_id: job.jobId,
      });
    },
  });
}
