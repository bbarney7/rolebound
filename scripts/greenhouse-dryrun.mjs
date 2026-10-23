#!/usr/bin/env node
// Greenhouse adapter — fill-only live dry run. Nothing is ever submitted.
//
//   node scripts/greenhouse-dryrun.mjs <live-url> <answers.json> <resume.pdf> \
//     [--board=<slug>] [--company-hint=<name>] [--json]
//
// This is the pre-merge proof that the fill script `generateFillScript` emits actually works
// on a real Greenhouse page: that its selectors reach the right elements, that the
// react-select keyboard dance (click → type the label → poll for the menu → Tab) leaves the value
// React thinks it holds, and that the resume upload lands. It fetches the posting's schema
// through the same pure functions the pi extension uses, validates the answers file against
// it, generates the fill script, runs it in a headed browser, and then reads every field back
// out of the DOM *itself* — independently of the readback the fill script does — so a bug in
// the script's own readback cannot report success.
//
// Both kinds of Greenhouse board are in scope, and they differ in where the form lives. A
// Greenhouse-hosted board (`job-boards.greenhouse.io/<board>/jobs/<id>`) renders it in the
// page; a company-hosted careers page carrying `?gh_jid=<id>` renders it inside an iframe
// served from `…greenhouse.io/embed/job_app…`, and needs `--board=<slug>` (or
// `--company-hint=<name>`) because its URL does not say which board the posting is on. The
// fill script resolves that frame itself and reports it back as `frame`; this harness waits
// on it and reads every field back out of it, so the readback is looking at the same document
// the fill wrote to.
//
// Four things keep this safe to point at a live posting:
//
//   1. The generated fill source is asserted to contain neither "Submit application" nor a
//      `getByRole("button"` call before the browser opens. The fill script has no business
//      touching a button; if it grows one, this run aborts instead of finding out live.
//   2. A `context.route` installed *before* the first page exists aborts and records every
//      non-GET/HEAD/OPTIONS request the browser makes, wherever it is bound. Deny by
//      default, with exactly one allowance: the resume upload's PUT/POST to
//      `grnhse-prod-*.s3.<region>.amazonaws.com` (RESUME_UPLOAD_RE), which has to go through
//      or the upload this run exists to prove would never happen. Everything else is
//      blocked, because a submission does not have to look like the POST to
//      boards-api.greenhouse.io that Greenhouse's own form uses — an allowlist of hosts
//      *not* to write to is a list of the ways this could go wrong that someone thought of.
//      A blocked request fails the run only when it was *Greenhouse-bound* (a
//      `*.greenhouse.io` host, or the S3 bucket the resume upload goes to): those are the
//      only hosts an application could be submitted to. A company-hosted careers page fires
//      its own analytics on every load — Datadog RUM, GA, ad pixels — and those are aborted
//      like everything else, listed under a heading of their own, and never fail the run;
//      counting them as submission attempts would make every embedded board fail for a
//      reason that has nothing to do with submitting. Greenhouse's own Snowplow page-view
//      beacon is Greenhouse-bound but is carved out the same way, at ANALYTICS_BEACON_RE.
//      It is `context.route` rather than `page.route`, and the context is
//      launched with `serviceWorkers: "block"`, so nothing can escape through a popup, a
//      second page or a worker that the page-level route never sees.
//   3. This harness clicks nothing. It runs the fill script and reads the DOM.
//   4. The browser gets its own throwaway user-data dir, never the workspace's
//      `.browser-data` — Chrome refuses two processes on one profile, and a dry run has no
//      business writing to the profile real applications are submitted from. If the
//      `channel: "chrome"` launch fails and this falls back to bundled Chromium, it does so
//      into a *fresh* temp profile: a half-initialised profile dir is what makes the retry
//      fail for a reason that has nothing to do with the browser.
//
// The one side effect that is real and worth knowing about is that allowance: attaching a
// file to Greenhouse's resume input makes the page POST it to S3 immediately, before any
// submit. It stages a file; it creates no application. Which is the other reason the resume
// argument must be a placeholder PDF.
//
// Real profile answers are fine, and are what a run on a company-hosted board is worth doing
// with: nothing is ever submitted, and the answers only ever reach input elements in the
// browser. The *resume* is the one input to think about, because attaching it does leave the
// browser (see the allowance above) — use a file you are content to have staged in a bucket.
// `scripts/greenhouse-dryrun.example.json` is a runnable example; keys beginning with `_` in
// the answers file are comments and are dropped before validation, so that file works as-is
// against the posting it was captured from.

import { createRequire } from "node:module";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { register } from "tsx/cjs/api";
import { chromium } from "playwright";

// The adapter is TypeScript and the workspace has no build step, so it is loaded through
// tsx's require hook. That is the CJS hook rather than the ESM one because the repo root has
// no `"type": "module"`: node treats the adapter's `.ts` files as CommonJS, and only the CJS
// hook resolves their extensionless relative imports. Registering it here is what lets this
// file run under a plain `node`, with no `npx tsx` wrapper.
register();
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  buildAnswerTemplate,
  compactSchema,
  fetchJobSchema,
  generateFillScript,
  parseGreenhouseUrl,
  validateAnswers,
} = require(path.join(HERE, "..", ".pi", "extensions", "lib", "adapters", "greenhouse.ts"));

const USAGE =
  "usage: node scripts/greenhouse-dryrun.mjs <live-url> <answers.json> <resume.pdf> " +
  "[--board=<slug>] [--company-hint=<name>] [--json]";

/** Everything the argv parse recognises; anything else beginning with `--` is a typo. */
const KNOWN_FLAG_RE = /^--(json$|board=|company-hint=)/;

// ── Safety ──

/** Substrings that must never appear in a fill script. Each one is a way to click Submit. */
const FORBIDDEN_IN_FILL_SOURCE = [
  { needle: "Submit application", why: "the accessible name of Greenhouse's submit button" },
  { needle: 'getByRole("button"', why: "a button lookup; the fill script must not click one" },
];

/** Methods a page load legitimately uses. Everything else is a write. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The only write this run lets out of the browser: the resume upload.
 *
 * Greenhouse's file input hands the bytes straight to a pre-signed S3 bucket the moment a
 * file is attached — Task 11's run recorded exactly one such request, a POST to
 * `https://grnhse-prod-jben-us-west-2.s3.us-west-2.amazonaws.com/`, and the pattern is
 * widened only across the bucket suffix and the region. Blocking it would break the upload
 * this harness exists to prove; letting anything else through would mean trusting a
 * denylist. It stages a file in a bucket; it creates no application.
 */
const RESUME_UPLOAD_RE = /^https:\/\/grnhse-prod[a-z0-9-]*\.s3\.[a-z0-9-]+\.amazonaws\.com\//;

/**
 * The one write a Greenhouse job-board page makes on its own: the Snowplow page-view beacon
 * the renderer fires a second after load. It is aborted like every other write — nothing
 * outside RESUME_UPLOAD_RE leaves the browser — but it is listed apart from the writes that
 * could be a submission and does not fail the run, because a submitted application is a POST
 * to the Job Board API (`boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>`) and can never
 * be a POST to this collector's fixed path. Counting it as a submission attempt would make
 * every run fail for a reason that has nothing to do with submitting.
 */
const ANALYTICS_BEACON_RE = /^https:\/\/c\.spl\.greenhouse\.io\/com\.snowplowanalytics\.snowplow\//;

/**
 * Could this write be the application leaving the browser?
 *
 * Only two kinds of host can carry one: Greenhouse itself, and the S3 bucket its file input
 * uploads to. Everything else a page writes to is its own instrumentation — a company-hosted
 * careers page runs Datadog RUM, Google Analytics and an ad pixel or two, and run 2 of Task 4
 * blocked 23 of them. All of it is still aborted; the difference is that only a
 * Greenhouse-bound write is evidence that this harness nearly submitted something, so only a
 * Greenhouse-bound write fails the run.
 */
const GREENHOUSE_HOST_RE = /(^|\.)greenhouse\.io$/i;
const UPLOAD_HOST_RE = /^grnhse-prod[a-z0-9-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/i;

function greenhouseBound(target) {
  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    // An unparseable URL is treated as Greenhouse-bound: the failing case is the safe one.
    return true;
  }
  return GREENHOUSE_HOST_RE.test(host) || UPLOAD_HOST_RE.test(host);
}

/** `method host` — all a third-party beacon is worth printing. */
function methodAndHost(entry) {
  try {
    return `${entry.method} ${new URL(entry.url).host}`;
  } catch {
    return `${entry.method} ${entry.url}`;
  }
}

/** A frame URL the fill script's `pick` would choose, which is what we watch navigate. */
const EMBED_FRAME_RE = /greenhouse\.io\/embed\/job_app/;

// ── Small helpers ──

function norm(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function clip(value, max = 46) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `filled[]`'s value for a file field is the path; the DOM only knows the basename. */
function expectedFor(answer, resumePath) {
  if (answer.type === "input_file") {
    return [path.basename(answer.id === "resume" ? resumePath : String(answer.value))];
  }
  return answer.value;
}

// ── Reading a field back out of the DOM ──

/**
 * What the page actually holds for one answered field, read without reusing anything the
 * fill script used to check its own work: text and textarea through `inputValue`, a file
 * field through the live `FileList` (or, once Greenhouse has swapped the input away, the
 * filename it renders in its place), a react-select by walking up from the combobox input
 * with `closest(".select__control")` rather than through the script's ancestor xpath, and a
 * `multi_value_multi_select` a board renders as a checkbox group by its own `name` attribute
 * (see `readCheckboxGroup` below). Every branch reports which of those it used, and a
 * reading that comes back empty carries the element's clipped `outerHTML` so a mismatch is
 * evidence rather than an assertion.
 */
async function readBack(root, answer) {
  if (answer.type === "input_text" || answer.type === "textarea") {
    return { actual: await root.locator(answer.selector).inputValue({ timeout: 5000 }), via: "inputValue" };
  }
  // `root.evaluate` rather than `locator.evaluate`: Greenhouse's file input carries
  // `class="visually-hidden"`, and a locator call waits for actionability the element will
  // never satisfy. Reading the document directly also keeps this honest — it shares no
  // machinery with the fill script's own readback.
  if (answer.type === "input_file") {
    const read = await root.evaluate(
      ({ selector, label }) => {
        const el = document.querySelector(selector);
        if (el !== null) {
          return { files: Array.from(el.files ?? []).map((file) => file.name), via: "FileList" };
        }
        // Greenhouse unmounts the <input type=file> the instant a file is attached and
        // renders the chosen filename where it was, dropping every id and data-testid that
        // named the field. What is left to key on is the field's own visible label.
        const owner = Array.from(document.querySelectorAll(".field-wrapper")).find(
          (wrapper) =>
            wrapper.querySelector(".file-upload__filename") !== null &&
            (wrapper.textContent ?? "").includes(label),
        );
        if (owner === undefined) {
          return {
            error: `nothing matches ${selector}, and no .field-wrapper labelled ${JSON.stringify(label)} shows an attached filename`,
          };
        }
        return {
          files: [owner.querySelector(".file-upload__filename").textContent.trim()],
          via: ".file-upload__filename",
          html: owner.querySelector(".file-upload__wrapper")?.outerHTML.slice(0, 400),
        };
      },
      { selector: answer.selector, label: answer.label },
    );
    if (read.error !== undefined) return { actual: [], via: "none", evidence: read.error };
    return { actual: read.files, via: read.via, evidence: read.files.length === 0 ? read.html : undefined };
  }
  if (answer.type === "multi_value_multi_select") {
    const combo = await root.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const control = el.closest(".select__control");
      if (control === null) return null;
      return {
        values: Array.from(control.querySelectorAll(".select__multi-value__label")).map((node) =>
          node.textContent.trim(),
        ),
        html: control.outerHTML.slice(0, 700),
      };
    }, answer.selector);
    // The react-select combobox is the preferred rendering and is tried first; when it is
    // not in the DOM at all, the board rendered this `[]` question as a checkbox group
    // instead — exactly the fallback `groupRefFor` exists for on the fill side — so the
    // read-back falls back the same way, off the group's own `name` rather than off
    // anything the fill script computed.
    if (combo !== null) {
      return {
        actual: combo.values,
        via: ".select__multi-value__label",
        evidence: combo.values.length === 0 ? combo.html : undefined,
      };
    }
    return readCheckboxGroup(root, answer.id);
  }
  const read = await root.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (el === null) return { error: `nothing matches ${selector}` };
    const control = el.closest(".select__control");
    if (control === null) return { error: "the combobox input has no .select__control ancestor" };
    const single = control.querySelector(".select__single-value");
    return {
      single: single === null ? null : single.textContent.trim(),
      html: control.outerHTML.slice(0, 700),
    };
  }, answer.selector);
  if (read.error !== undefined) return { actual: "", via: "none", evidence: read.error };
  return {
    actual: read.single ?? "",
    via: ".select__single-value",
    evidence: read.single === null ? read.html : undefined,
  };
}

/**
 * A `[]` question some boards render as a plain group of checkboxes sharing one `name`
 * rather than as a react-select combobox. Read independently of the fill script: the group
 * is found by `input[type="checkbox"][name="<id>"]`, the same selector shape
 * `groupRefFor` in `answers.ts` builds, but built fresh here from the raw id rather than by
 * calling it, so a bug in that function would not also hide from this check. Each checked
 * box's wording comes from `label[for="<box id>"]`, since a checkbox carries no label text
 * of its own — matching exactly how the fill script itself reads a group back.
 */
async function readCheckboxGroup(root, id) {
  const read = await root.evaluate((name) => {
    const boxes = Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`));
    if (boxes.length === 0) {
      return { error: `no checkboxes named ${name}, and no react-select combobox at this question's selector either` };
    }
    const labels = boxes
      .filter((box) => box.checked)
      .map((box) => (document.querySelector(`label[for="${CSS.escape(box.id)}"]`)?.textContent ?? "").trim())
      .filter((text) => text !== "");
    return { labels, count: boxes.length, html: boxes[0].closest(".field-wrapper")?.outerHTML.slice(0, 700) };
  }, id);
  if (read.error !== undefined) return { actual: [], via: "none", evidence: read.error };
  return {
    actual: read.labels,
    via: 'input[type="checkbox"][name]',
    evidence: read.labels.length === 0 ? `${read.count} checkbox(es) named ${id}, none checked — ${read.html}` : undefined,
  };
}

/**
 * `unlisted_select` (the `candidate-location` geocoder type-ahead) is compared by
 * containment rather than equality: Greenhouse's geocoder answers a typed city with a
 * fuller string ("San Francisco" resolves to "San Francisco, California, United States"),
 * so the answer that was asked for is a substring of what the control ends up holding, and
 * never the reverse. Every other type is still exact.
 */
function matches(expected, actual, type) {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const want = (Array.isArray(expected) ? expected : [expected]).map(norm).sort();
    const got = (Array.isArray(actual) ? actual : [actual]).map(norm).sort();
    return want.length === got.length && want.every((value, i) => value === got[i]);
  }
  if (type === "unlisted_select") return norm(actual).includes(norm(expected));
  return norm(expected) === norm(actual);
}

// ── Table ──

function renderTable(rows) {
  const header = ["id", "label", "type", "expected", "actual", "match"];
  const body = rows.map((row) => [
    row.id,
    clip(row.label, 38),
    row.type,
    clip(row.expected),
    clip(row.actual),
    row.match ? "yes" : "NO",
  ]);
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...body.map((line) => line[i].length)),
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("-+-"), ...body.map(line)].join("\n");
}

// ── Main ──

async function main(argv) {
  const wantJson = argv.includes("--json");
  // An unrecognised `--flag` is rejected rather than shrugged off as a positional: a
  // mistyped `--boards=` would otherwise be counted as the fourth argument and the run
  // would die on the argument count, naming the wrong problem.
  const unknown = argv.filter((arg) => arg.startsWith("--") && !KNOWN_FLAG_RE.test(arg));
  if (unknown.length > 0) fail(`${USAGE}\n\nUnknown option(s): ${unknown.join(", ")}.`);
  const flag = (name) => {
    const prefix = `--${name}=`;
    const hit = argv.filter((arg) => arg.startsWith(prefix)).pop();
    return hit === undefined ? undefined : hit.slice(prefix.length);
  };
  // A company-hosted `?gh_jid=` URL carries the job id but not the board slug, so without
  // one of these two `parseGreenhouseUrl` refuses it before a browser ever opens.
  const boardOverride = flag("board");
  const companyHint = flag("company-hint");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 3) fail(`${USAGE}\n\nExpected 3 arguments, got ${positional.length}.`);
  const [url, answersArg, resumeArg] = positional;

  // Both paths are resolved and stat'd the way `greenhouse_prepare_fill` resolves
  // `resume_path`: relative to the working directory, and it has to be a real file.
  const answersPath = path.resolve(process.cwd(), answersArg);
  const resumePath = path.resolve(process.cwd(), resumeArg);
  for (const [what, file] of [["Answers file", answersPath], ["Resume", resumePath]]) {
    let info;
    try {
      info = await stat(file);
    } catch {
      fail(`${what} ${file} does not exist.`);
    }
    if (!info.isFile()) fail(`${what} ${file} is not a file.`);
  }

  const ref = parseGreenhouseUrl(url, { boardOverride, companyHint });
  if ("error" in ref) fail(ref.error);
  const fetched = await fetchJobSchema(ref.board, ref.jobId, { boardGuessed: ref.boardGuessed });
  if (!fetched.ok) fail(`Could not fetch the schema: ${fetched.error}`);
  const schema = compactSchema(fetched.raw);
  process.stdout.write(
    `${schema.title} — ${schema.company} (${ref.board}/${ref.jobId}), ${schema.questions.length} question(s)\n`,
  );

  let answers;
  try {
    answers = JSON.parse(await readFile(answersPath, "utf8"));
  } catch (err) {
    fail(`Could not read ${answersPath} as JSON: ${err.message}`);
  }
  // `_`-prefixed keys are comments (the example file's `_note`), so the committed example is
  // runnable as-is; validateAnswers would otherwise reject them as unknown questions.
  const comments = Object.keys(answers).filter((key) => key.startsWith("_"));
  for (const key of comments) delete answers[key];

  const checked = validateAnswers(schema, answers);
  for (const note of [...schema.notes, ...checked.notes]) process.stdout.write(`note: ${note}\n`);
  if (!checked.ok) {
    const template = JSON.stringify(buildAnswerTemplate(schema).answers, null, 2);
    fail(
      `The answers file does not fit this posting.\n` +
        (checked.unanswered.length > 0 ? `Unanswered (required): ${checked.unanswered.join(", ")}\n` : "") +
        checked.errors.map((error) => `- ${error}\n`).join("") +
        `\nThe blank template for this job is:\n${template}\n`,
    );
  }
  const resolved = checked.resolved;
  const byId = new Map(resolved.map((answer) => [answer.id, answer]));

  // The job id makes the script's own wrong-page guard real: it refuses to type anything
  // unless the tab is on this posting, which is the same check the pi tool relies on.
  const fillSource = generateFillScript(resolved, resumePath, ref.jobId);
  for (const { needle, why } of FORBIDDEN_IN_FILL_SOURCE) {
    if (fillSource.includes(needle)) {
      fail(`Refusing to run: the generated fill script contains ${JSON.stringify(needle)} (${why}).`);
    }
  }
  process.stdout.write(
    `fill script: ${fillSource.length} chars, ${resolved.length} answer(s), no submit affordance\n`,
  );

  const profileRoot = process.env.GREENHOUSE_DRYRUN_PROFILE_ROOT ?? tmpdir();
  let profileDir = await mkdtemp(path.join(profileRoot, "greenhouse-dryrun-"));
  process.stdout.write(`browser profile: ${profileDir}\n`);

  const blocked = [];
  const blockedTelemetry = [];
  const blockedThirdParty = [];
  const allowedUploads = [];
  let context;
  try {
    const launchOptions = {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
      // A service worker can issue requests of its own, and `context.route` is the only
      // level that sees them. Blocking them outright is simpler than policing them.
      serviceWorkers: "block",
    };
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions,
        channel: "chrome",
      });
    } catch (err) {
      process.stdout.write(`channel:chrome unavailable (${err.message.split("\n")[0]}); using bundled chromium\n`);
      // A launch that threw may still have left a context and will certainly have left a
      // half-written profile dir; both are retried from scratch rather than reused.
      if (context !== undefined) {
        await context.close().catch(() => {});
        context = undefined;
      }
      profileDir = await mkdtemp(path.join(profileRoot, "greenhouse-dryrun-"));
      process.stdout.write(`retrying in a fresh profile: ${profileDir}\n`);
      context = await chromium.launchPersistentContext(profileDir, launchOptions);
    }

    // Installed on the context before any page is touched, so nothing can slip out while the
    // page is loading, and nothing can slip out through a popup or a second page either.
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const target = request.url();
      if (!READ_METHODS.has(method)) {
        const record = {
          method,
          url: target.slice(0, 300),
          resourceType: request.resourceType(),
          postData: (request.postData() ?? "").slice(0, 300),
        };
        // Deny by default. Only the resume upload is let through; everything else is a
        // write this run has no business making, submission-shaped or not.
        if (!RESUME_UPLOAD_RE.test(target)) {
          const bucket = ANALYTICS_BEACON_RE.test(target)
            ? blockedTelemetry
            : greenhouseBound(target)
              ? blocked
              : blockedThirdParty;
          bucket.push(record);
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        allowedUploads.push(record);
      }
      await route.continue().catch(() => {});
    });

    const page = context.pages()[0] ?? (await context.newPage());

    // Every navigation of the frame the fill works in, timestamped from the moment this run
    // opened the page. Run 2 of Task 4 lost the first four text fields it typed and the two
    // candidate explanations — the embed re-navigating, or React remounting the same
    // document — are told apart here: a navigation mid-fill shows up in this list, and a
    // remount without one shows up as the anchor handle below not surviving.
    const navigations = [];
    const openedAt = Date.now();
    page.on("framenavigated", (frame) => {
      if (EMBED_FRAME_RE.test(frame.url())) {
        navigations.push({ t: Date.now() - openedAt, url: frame.url().slice(0, 120) });
      }
    });

    // Greenhouse's uploader asks for its S3 credentials before it will take a file, and that
    // request is the reason the fill attaches files last and re-tries an attach the page did
    // not confirm. Registered before navigation because on a hosted board it can land while
    // the form is still coming up; the report times each response against the fill's start,
    // so a response that arrived *after* the fill began is the retry earning its keep.
    const presigned = [];
    page.on("response", (response) => {
      if (/uncacheable_attributes\/presigned_fields/.test(response.url())) {
        presigned.push({ status: response.status(), at: Date.now() });
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Wait for the application form wherever it is: in the page on a Greenhouse-hosted board,
    // or in the `greenhouse.io/embed/job_app` iframe a company-hosted careers page mounts it
    // in. The frame rule is the same one the fill script's own `pick` uses, and the anchor is
    // the same `input#first_name, input#email` it anchors to — `form` would have been the
    // wrong thing to wait for on a careers page, whose search and newsletter forms say nothing
    // about whether the application is up.
    //
    // Expiring here prints and continues rather than throwing. A page with no form at all is a
    // case worth running the fill against: the `form not found` it returns, with the list of
    // frames it looked in, is the result of record, and a harness exception in its place would
    // report the harness's opinion instead of the script's.
    const ANCHOR = "input#first_name, input#email";
    const anchoredIn = async () => {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        if (!/greenhouse\.io\/embed\/job_app/.test(frame.url())) continue;
        if (await frame.locator(ANCHOR).first().isVisible().catch(() => false)) return frame;
      }
      const inPage = await page.locator(ANCHOR).first().isVisible().catch(() => false);
      return inPage ? page : undefined;
    };
    const waitStarted = Date.now();
    let formIn = await anchoredIn();
    while (formIn === undefined && Date.now() - waitStarted < 30_000) {
      await page.waitForTimeout(500);
      formIn = await anchoredIn();
    }
    process.stdout.write(
      formIn === undefined
        ? "no application form in the page or its frames after 30 s; running the fill anyway\n"
        : `application form: ${formIn === page ? "the page itself" : formIn.url()}\n`,
    );
    // React hydrates the selects after the markup lands; the fill script assumes a settled page.
    await page.waitForTimeout(5_000);

    // A handle on the anchor input, taken before the fill and asked afterwards whether it is
    // still in the document. An element that does not survive was replaced under the script,
    // which is what discards a typed value without any navigation happening.
    const anchorHandle =
      formIn === undefined
        ? null
        : await formIn.locator(ANCHOR).first().elementHandle({ timeout: 5_000 }).catch(() => null);

    // The fill source is the same text `greenhouse_prepare_fill` writes to disk for the
    // Playwright MCP's run_code. `new Function` evaluates it to the `async (page) => …` it is.
    const runFill = new Function(`return (${fillSource});`)();
    const fillStartedAt = Date.now();
    const result = await runFill(page);

    const anchorSurvived =
      anchorHandle === null ? null : await anchorHandle.evaluate((n) => n.isConnected).catch(() => false);

    // The fill script resolves its own document and names it in `frame`: the embed's URL when
    // it worked inside one, null when it worked in the page. Reading the fields back out of
    // the page after an embedded fill would find nothing at all and report every field as a
    // mismatch, so the readback follows the fill into whichever document it wrote to.
    const named = result.frame ? page.frames().find((f) => f.url() === result.frame) : undefined;
    const root = named ?? page;
    if (result.frame && named === undefined) {
      // Otherwise every row reads "nothing matches input#…" and looks like a fill that did
      // nothing, when what happened is that the document it filled is no longer there.
      process.stdout.write(
        `the fill named frame ${result.frame} but no live frame has that URL; reading back from the top page instead\n`,
      );
    }

    const rows = [];
    for (const field of result.filled ?? []) {
      const answer = byId.get(field.id);
      if (answer === undefined) {
        rows.push({
          id: field.id,
          label: field.label,
          type: "?",
          expected: field.value,
          actual: "(not in resolved answers)",
          match: false,
        });
        continue;
      }
      const expected = expectedFor(answer, resumePath);
      let actual;
      let evidence;
      let via = "none";
      try {
        ({ actual, evidence, via } = await readBack(root, answer));
      } catch (err) {
        actual = `readback failed: ${err.message.split("\n")[0]}`;
      }
      rows.push({
        id: answer.id,
        label: answer.label,
        type: answer.type,
        selector: answer.selector,
        expected,
        actual,
        via,
        evidence,
        match: matches(expected, actual, answer.type),
      });
    }

    // A resolved answer that came back in neither filled[] nor skipped[] nor
    // validation_errors[] was dropped silently, which is worse than a reported failure.
    const accounted = new Set([
      ...(result.filled ?? []).map((f) => f.id),
      ...(result.skipped ?? []).map((s) => s.id),
      ...(result.validation_errors ?? []).map((e) => e.id),
    ]);
    const unaccounted = resolved.filter((answer) => !accounted.has(answer.id));

    // Required controls the fill never touched, read straight from the DOM independently of
    // what the fill script reported — a control the fill silently skipped shows up here
    // instead of behind a PASS. React-selects keep their value in a sibling
    // `.select__single-value` / `.select__multi-value__label`, not `input.value`, so read
    // through the `.select__control` ancestor when there is one. A checkbox group is
    // satisfied by any one of its boxes being checked.
    const requiredUnfilled = await root.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("input, textarea, select")) {
        if (el.type === "hidden") continue;
        const required = el.required || el.getAttribute("aria-required") === "true";
        if (!required) continue;
        const box = el.closest(".select__control");
        const shown = box
          ? (box.querySelector(".select__single-value, .select__multi-value__label")?.textContent || "").trim()
          : el.type === "checkbox" || el.type === "radio" ? (el.checked ? "on" : "") : (el.value || "").trim();
        if (shown) continue;
        const name = el.getAttribute("name") || "";
        // A checkbox group is satisfied by any one of its boxes.
        if (
          el.type === "checkbox" &&
          name &&
          [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)].some((b) => b.checked)
        ) {
          continue;
        }
        const label = (
          el.labels?.[0]?.innerText || document.querySelector(`label[for="${CSS.escape(el.id || "")}"]`)?.innerText || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        // A row with a blank id and label identifies nothing to a reader. Fall back through
        // the aria-label, the text of the control's own `.field-wrapper`, and — failing both
        // — the tag plus its index among its siblings, so every row names something.
        const siblingIndex = Array.from(el.parentElement?.children ?? []).indexOf(el);
        const fallbackName =
          (el.getAttribute("aria-label") || "").trim() ||
          (el.closest(".field-wrapper")?.innerText || "").replace(/\s+/g, " ").trim() ||
          `${el.tagName.toLowerCase()}[${siblingIndex}]`;
        // A checkbox group shares one `name` across distinct `id`s — key on the name so the
        // group is reported once, not once per box.
        out.push({
          id: (el.type === "checkbox" && name ? name : el.id || name) || fallbackName,
          label: (label || fallbackName).slice(0, 70),
          tag: el.tagName.toLowerCase(),
          type: el.type,
        });
      }
      // One entry per checkbox group, not one per box.
      return out.filter((r, i) => r.type !== "checkbox" || out.findIndex((x) => x.id === r.id) === i);
    });

    const report = {
      job: { url, board: ref.board, jobId: ref.jobId, title: schema.title, company: schema.company },
      ok: result.ok,
      reason: result.reason,
      frame: result.frame ?? null,
      frames: result.frames,
      rows,
      skipped: result.skipped ?? [],
      validation_errors: result.validation_errors ?? [],
      unaccounted: unaccounted.map((a) => ({ id: a.id, label: a.label, type: a.type })),
      requiredUnfilled,
      blocked,
      blocked_telemetry: blockedTelemetry,
      blocked_third_party: blockedThirdParty,
      allowed_uploads: allowedUploads,
      navigations,
      presigned_fields: presigned.map((entry) => ({ status: entry.status, at: entry.at - fillStartedAt })),
      anchor_survived: anchorSurvived,
    };

    if (wantJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      // Which document the fill worked in, and — when it filled nothing — why. A run with an
      // empty table has no fields to explain itself with; the reason and the frames the script
      // looked in are the whole finding.
      process.stdout.write(`\nframe: ${result.frame ?? "top"}\n`);
      if (result.ok === false && rows.length === 0) {
        process.stdout.write(`reason: ${result.reason}\n`);
        for (const seen of result.frames ?? []) process.stdout.write(`frame seen: ${seen}\n`);
      }
      process.stdout.write(`\n### filled (${rows.length})\n${renderTable(rows)}\n`);
      const byVia = new Map();
      for (const row of rows) byVia.set(row.via, [...(byVia.get(row.via) ?? []), row.id]);
      process.stdout.write("\nread back independently of the fill script, by:\n");
      for (const [via, ids] of byVia) process.stdout.write(`- ${via}: ${ids.join(", ")}\n`);
      for (const row of rows) {
        if (row.match) continue;
        process.stdout.write(`\nMISMATCH ${row.id} (${row.selector})\n`);
        process.stdout.write(`  expected: ${JSON.stringify(row.expected)}\n`);
        process.stdout.write(`  actual:   ${JSON.stringify(row.actual)}\n`);
        if (row.evidence !== undefined) process.stdout.write(`  dom:      ${row.evidence}\n`);
      }
      process.stdout.write(`\n### skipped (${report.skipped.length})\n`);
      for (const entry of report.skipped) {
        process.stdout.write(`- ${entry.id} — ${entry.label}: ${entry.reason}\n`);
      }
      if (requiredUnfilled.length > 0) {
        process.stdout.write(`\n### required but unfilled (${requiredUnfilled.length})\n`);
        for (const entry of requiredUnfilled) {
          process.stdout.write(`- ${entry.id} — ${entry.label} [${entry.tag}/${entry.type}]\n`);
        }
      }
      process.stdout.write(`\n### validation_errors (${report.validation_errors.length})\n`);
      for (const entry of report.validation_errors) {
        process.stdout.write(`- ${entry.id} — ${entry.label}: ${entry.error}\n`);
      }
      if (unaccounted.length > 0) {
        process.stdout.write(`\n### unaccounted (${unaccounted.length})\n`);
        for (const answer of unaccounted) {
          process.stdout.write(`- ${answer.id} — ${answer.label} (${answer.type})\n`);
        }
      }
      process.stdout.write(`\n### embed frame navigations (${navigations.length})\n`);
      for (const entry of navigations) process.stdout.write(`- +${entry.t} ms ${entry.url}\n`);
      // Timed against the fill's start, so a negative offset means the uploader had its S3
      // credentials before the first field was typed and a positive one means the attach had
      // to wait — which is what a re-tried attach looks like from outside the script.
      if (report.presigned_fields.length === 0) {
        process.stdout.write("\npresigned_fields: none seen\n");
      } else {
        process.stdout.write("\n");
        for (const entry of report.presigned_fields) {
          process.stdout.write(`presigned_fields: ${entry.status} at ${entry.at >= 0 ? "+" : ""}${entry.at} ms\n`);
        }
      }
      process.stdout.write(
        `\nanchor element survived the fill: ${anchorSurvived === null ? "(no handle taken)" : anchorSurvived ? "yes" : "no"}\n`,
      );
      process.stdout.write(
        `\n### blocked requests — Greenhouse-bound writes that are not the resume upload (${blocked.length})\n`,
      );
      for (const entry of blocked) {
        process.stdout.write(`- ${entry.method} ${entry.url} [${entry.resourceType}] ${entry.postData}\n`);
      }
      process.stdout.write(
        `\n### also blocked — Snowplow page-view beacons, not submissions (${blockedTelemetry.length})\n`,
      );
      for (const entry of blockedTelemetry) {
        process.stdout.write(`- ${entry.method} ${entry.url} [${entry.resourceType}]\n`);
      }
      process.stdout.write(
        `\n### also blocked — third-party telemetry, not submissions (${blockedThirdParty.length})\n`,
      );
      for (const entry of blockedThirdParty) process.stdout.write(`- ${methodAndHost(entry)}\n`);
      process.stdout.write(
        `\n### allowed writes — the resume upload to S3, and nothing else (${allowedUploads.length})\n`,
      );
      for (const entry of allowedUploads) {
        process.stdout.write(`- ${entry.method} ${entry.url} [${entry.resourceType}]\n`);
      }
    }

    const failures = [];
    // Four different things end a fill and they are not the same failure, so they are not
    // reported with the same words. `form not found` means the script never saw its anchor in
    // the page or in any frame, and `form not settled` means it did see one and the form never
    // held still long enough to type into — for both, the frame list is what a human needs
    // next. `deadline` means it did see the form and ran out of the 30 s it gives itself, so
    // the partial table above is real. Anything else came out of the script's outer catch and
    // is passed through, which is why that branch names the script rather than the page.
    if (result.reason !== undefined) {
      const reason = String(result.reason);
      const frames = (result.frames ?? []).join(", ");
      const seen = frames === "" ? "none" : frames;
      failures.push(
        reason.startsWith("form not found")
          ? `no application form found (frames: ${seen})`
          : reason.startsWith("form not settled")
            ? `the application form never settled — it kept remounting (frames: ${seen})`
            : reason === "deadline"
              ? "fill ran out of time"
              : `the fill script threw: ${reason}`,
      );
    }
    const bad = rows.filter((row) => !row.match);
    if (bad.length > 0) failures.push(`${bad.length} field(s) did not read back: ${bad.map((r) => r.id).join(", ")}`);
    if (report.validation_errors.length > 0) {
      failures.push(`${report.validation_errors.length} validation error(s): ${report.validation_errors.map((e) => e.id).join(", ")}`);
    }
    if (unaccounted.length > 0) failures.push(`${unaccounted.length} answer(s) unaccounted for`);
    if (blocked.length > 0) {
      failures.push(
        `${blocked.length} Greenhouse-bound write(s) were blocked — something tried to leave the browser`,
      );
    }
    if (requiredUnfilled.length > 0) {
      failures.push(`${requiredUnfilled.length} required control(s) left unfilled`);
    }

    if (!wantJson) {
      process.stdout.write(
        failures.length === 0
          ? `\n### verdict\nPASS — ${rows.length}/${rows.length} fields match, no required control left unfilled, 0 Greenhouse-bound writes blocked, nothing submitted.\n`
          : `\n### verdict\nFAIL\n${failures.map((f) => `- ${f}\n`).join("")}`,
      );
    }
    return failures.length === 0 ? 0 : 1;
  } finally {
    if (context !== undefined) await context.close().catch(() => {});
  }
}

process.exitCode = await main(process.argv.slice(2));
