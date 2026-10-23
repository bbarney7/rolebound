// Greenhouse job-board adapter: the browser scripts.
//
// Three generators, each returning the source text of a self-contained `async (page) => …`
// function for the Playwright MCP's run_code tool: one fills a posting's form, one submits
// it, one types the emailed security code and submits again. Imported through the
// `../greenhouse` barrel, never directly.
//
// Three constraints shape every line of what they emit.
//
// The sandbox. run_code evaluates the source as `(<source>)` in a vm context whose only
// globals are `page` and an internal handle, so a script may not name `require`, `console`,
// `process`, `setTimeout`, `Buffer`, `window` or `document`; a delay is `page.waitForTimeout`.
// Every exit path returns a JSON-serialisable object and the whole body is wrapped in a
// catch, because a body that falls off the end returns `undefined` and the caller gets no
// result block at all, while a throw surfaces as a bare error with no stack. Every waiting
// call passes an explicit `{ timeout: … }`, since the ambient default is 30 s.
//
// The budget. The MCP echoes the entire source back into model context after every call, so
// the fixed half of each script — everything but the data literal — is capped: 4,096 B for
// submit and OTP, and 6,144 B for the fill, which Decisions 12 to 16 raised one capability at
// a time from the original 3 KB (`greenhouse.test.ts`, "stays small enough to echo back into
// context on every call", where each raise is recorded with what it bought). Decision 16 is
// the last of them: the fill template is at its ceiling. That budget is what pays for the
// templates carrying no comments, for one-line helpers (`hit`, `bad`, `bail`) in place of
// four copies of the same object literal, and for the select read-back running one code path
// instead of two: the explanation lives here, where it costs nothing.
//
// The injection boundary (Decision 9). Ids, labels, selectors, answers, the resume path, the
// job id and the security code all come from the model or from Greenhouse's API. They are
// emitted as one `JSON.stringify` literal on a line of its own and the fixed template body
// iterates over it; nothing from them is ever concatenated into code. That is why a label
// reading "Do you require sponsorship?" is harmless: it is a JSON string, not a token.

import { elementRef, isValidElementId } from "./answers";
import type { ResolvedAnswer } from "./answers";

// ── Results ──

/** One field the fill script reached, in the form it reports back. */
export interface FilledField {
  id: string;
  label: string;
  value: string | string[];
}

export interface SkippedField {
  id: string;
  label: string;
  reason: string;
}

export interface FieldError {
  id?: string;
  label?: string;
  error: string;
}

/** What `generateFillScript`'s source resolves to when run_code evaluates it. */
export interface FillResult {
  /** False when anything landed in `validation_errors`, or when the body itself failed. */
  ok: boolean;
  filled: FilledField[];
  skipped: SkippedField[];
  validation_errors: FieldError[];
  /**
   * The outer catch, the wrong-page guard, `form not found` (no anchor in the page or in any
   * frame), `form not settled` (an anchor that never held still long enough to type into), or
   * `deadline` when the fill ran out of wall-clock time before it reached every answer.
   */
  reason?: string;
  /** The Greenhouse embed the script worked in, or null when it worked in the page itself. */
  frame: string | null;
  /**
   * Only on `form not found` and `form not settled`: every frame URL the page was showing, so
   * whoever reads the result can see where the form actually was.
   */
  frames?: string[];
}

export interface SubmitResult {
  state: "captcha" | "otp_required" | "submitted" | "validation_errors" | "unknown" | "error";
  validation_errors?: FieldError[];
  detail?: string;
}

export interface OtpResult {
  state: "submitted" | "captcha" | "error";
  detail?: string;
}

// ── Emitting the data literal ──

/**
 * The JSON literal a template reads its data from.
 *
 * U+2028 and U+2029 pass through `JSON.stringify` unescaped and are legal inside an ES2019
 * string literal, but the source is handed to a `vm` whose parser is not ours to assume, so
 * they are escaped rather than trusted.
 */
function dataLiteral(value: unknown): string {
  return `const data = ${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};`;
}

/** Wrap a body as the `async (page) => …` source run_code evaluates. */
function script(data: string | null, body: string): string {
  return `async (page) => {\n${data === null ? "" : `${data}\n`}${body}\n}`;
}

// ── The wrong-page guard (Ruling P) ──

const JOB_ID_RE = /^\d+$/;

/**
 * Every generated script's first act is to check it is standing on the job it was written
 * for. These scripts run through an MCP that owns a long-lived browser, so the tab can have
 * moved on between the tool call that wrote the script and the call that runs it — to
 * another posting, to a login wall, to the previous application's confirmation page. Filling
 * the wrong posting wastes a turn; submitting it is not recoverable.
 *
 * Throws rather than emitting a script whose guard would be a no-op: an id that is not all
 * digits cannot have come from `parseGreenhouseUrl` or from a valid sidecar, so the caller
 * is not holding what it thinks it is.
 */
function checkedJobId(jobId: string, what: string): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new Error(
      `Refusing to generate a ${what} script for job id ${JSON.stringify(String(jobId)).slice(0, 40)}: a Greenhouse job id is all digits.`,
    );
  }
  return jobId;
}

/**
 * The guard itself, as one expression each template drops into its own return shape.
 *
 * A substring test against the three shapes a posting URL takes — `/jobs/<id>` on a
 * Greenhouse-hosted board, `gh_jid=<id>` on a company-hosted embed's parent, `token=<id>` on
 * the embed frame's own URL — rather than a whole-URL comparison, because the live page
 * carries `?gh_src=`, UTM parameters and a trailing slash that the queue file's URL does not.
 * Both URLs are tested (Decision 12 amends Ruling P): a careers site is free to put nothing
 * at all about the job in its top-level URL, and the embed's `token=` is then the only place
 * the id appears. The pattern is built from `data.jobId` at run time, which is safe precisely
 * because `checkedJobId` has already refused anything but digits: there is no regex
 * metacharacter left to inject.
 */
const OFF_JOB = `!new RegExp("(/jobs/|gh_jid=|token=)" + data.jobId + "(?!\\\\d)").test(page.url() + " " + root.url())`;

/** What a wrong-page return says, built in-script from the id the script was written for. */
const WRONG_PAGE = `"wrong page: expected job " + data.jobId`;

// ── Which document the script works in (Decision 12) ──

/**
 * A company-hosted board renders the application form inside an iframe served from
 * `…greenhouse.io/embed/job_app…`, and a locator built on the page matches nothing inside
 * it: the first live Datadog run filled zero fields for exactly that reason. `pick` returns
 * that frame when it is there and the page itself when it is not, so every locator below can
 * say `root` and stop caring which kind of board it is standing on.
 *
 * The pattern is a template literal, never data (Decision 9), and `page.frames()` is a local
 * array rather than a round trip, so re-running this costs nothing.
 */
const PICK = `const pick = () => page.frames().find((f) => f !== page.mainFrame() && /greenhouse\\.io\\/embed\\/job_app/.test(f.url())) || page;`;

/** The frame a result names: null on a Greenhouse-hosted board, the embed's URL otherwise. */
const FRAME = `root === page ? null : root.url()`;

/**
 * Resolve the root, then give a slow embed one more chance *before* the guard.
 *
 * The guard's `token=` clause only helps once `root` is the embed, so a careers page whose
 * own URL carries no `/jobs/<id>` and no `gh_jid=` would be refused as `wrong page` while the
 * iframe was still loading. One second, on every hosted-board run of every script, buys the
 * embed that second chance.
 */
const REPICK = `root = pick();
if (root === page) { await page.waitForTimeout(1000); root = pick(); }`;

// ── Shared template fragments ──

/**
 * Read the page's text once per poll. Everything the submit and OTP scripts decide from
 * wording — the confirmation, the security-code prompt, a "press and hold" challenge —
 * tests this one string, so a poll costs one round trip rather than four.
 */
const BODY_TEXT = `const bodyText = async () => {
try { return await root.locator("body").innerText({ timeout: 2000 }); } catch (e) { return ""; }
};`;

/**
 * The CAPTCHA check, run before the submit click and again on every poll after it. The
 * iframe probe is `isVisible`, which resolves against the current DOM instead of waiting,
 * so re-running it each poll costs nothing; the wording check reuses the body text the
 * caller already fetched.
 *
 * It probes both documents when they differ, because a challenge raised over an embedded
 * form can be mounted either in the embed beside the form or in the parent page over it, and
 * clicking Submit through a CAPTCHA is the one mistake with no recovery.
 */
const SEES_CAPTCHA = `const seesCaptcha = async (body) => {
for (const r of root === page ? [page] : [page, root]) {
try { if (await r.locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="turnstile"]').first().isVisible({ timeout: 1000 })) return true; } catch (e) {}
}
return /verify you are human|verifying you're human|press and hold/i.test(body);
};`;

/**
 * Did the submission actually go through?
 *
 * Only a positive signal counts: one of the wordings a Greenhouse success page uses, a
 * confirmation URL, or a thank-you in the page title. The absence of the form is deliberately
 * *not* one of them — a session timeout, a CAPTCHA that replaces the form, and a posting
 * rendered inside `#grnhse_iframe` all make the form vanish without anything having been
 * submitted, and `submitted` is terminal downstream: the queue entry is moved and never
 * retried.
 *
 * The wording list is broad because the cost of missing a real confirmation is a duplicate
 * application, while the cost of a false one is a job that looks applied-to and is not. Boards
 * that leave the URL and the title unchanged are the reason it cannot lean on those alone.
 *
 * Breadth is also why the wording branch needs a pre-click baseline. Plenty of job
 * descriptions say "we'll be in touch" in their own prose, and a posting whose description
 * stays on the page after the click would then read as confirmed the instant the poll starts,
 * turning "the click did nothing" into `submitted`. So `confirmedText` is split out and run
 * once *before* the click; when it was already true there, the wording alone proves nothing
 * and success needs either the URL / title signal or the wording plus a form that has gone.
 * `gone` is the caller's latched `vanished`, which is why the poll now probes `formGone`
 * before it asks this.
 *
 * The URL and title signals are read from *both* documents. An embedded board's parent
 * usually navigates on success while the iframe is torn down underneath it, so reading only
 * `root` would drop the page-level half of Ruling J's evidence; reading only `page` would
 * drop the frame's own `/embed/job_app/confirmation`.
 */
const CONFIRMED = `const confirmedText = (body) => /thank(?:s| you) for applying|received your application|application (?:(?:has been|was) (?:received|submitted)|submitted)|successfully submitted|we'll be in touch/i.test(body);
const confirmed = async (body, pre, gone) => {
if (confirmedText(body) && (!pre || gone)) return true;
if (String(page.url()).indexOf("/confirmation") > -1) return true;
if (root !== page && String(root.url()).indexOf("/confirmation") > -1) return true;
try { if (/thank/i.test(await page.title())) return true; } catch (e) {}
try { if (root !== page && /thank/i.test(await root.title())) return true; } catch (e) {}
return false;
};`;

/**
 * Is the form gone? On its own this is absence of evidence, so a caller may only report it
 * as `unknown`, never as success — and only after the poll has expired, since a confirmation
 * may still be a tick away. A probe that fails reads as "still there" rather than as success,
 * and `button[type=submit]` is vacuously 0 on a button that carries no `type`, which is the
 * other reason this may never stand alone. Both shapes ride in one selector so the check is
 * one round trip per tick rather than two, and the whole thing is a statement rather than a
 * helper because each template uses it exactly once, inside its poll: a probe that fails
 * simply leaves `vanished` where it was, which reads as "still there".
 */
const FORM_GONE = `try { if (!(await root.locator("button[type=submit], form").count())) vanished = true; } catch (e) {}`;

// ── Fill ──

/**
 * Why the fill waits for the form to settle before it types (Decision 13).
 *
 * The first live run on a company-hosted board typed into a document that was replaced
 * underneath it: the first four fields it filled read back empty half a minute later, while
 * everything from the fifth on survived. The anchor being visible is not the same as the form
 * being ready — Greenhouse mounts the markup, then React hydrates it, and hydration resets
 * whatever was typed in between. So each attempt takes an element handle on the anchor, waits
 * for that handle to be both connected and carrying a React fiber key, and then requires
 * 1,500 ms in which the frame's URL does not change and the handle stays connected. Three
 * attempts; a run that anchors but never settles returns `form not settled`, which is a
 * different finding from `form not found` and reads as "the form kept remounting".
 *
 * Every way an attempt can fail costs that attempt and nothing more — the visible wait, the
 * handle grab, and the hold alike. The grab is the one that has to be caught explicitly: an
 * anchor that detaches between being seen and being held, or a `Frame` the parent replaces
 * underneath, rejects rather than returning falsely, and an uncaught rejection there would
 * unwind to the outer catch and report a Playwright timeout string as the whole result.
 *
 * `root.waitForFunction` is the one page-function call in any of these templates, and it is
 * inside Decision 10's sandbox contract rather than an exception to it: its callback is a
 * template literal (nothing from the model or from Greenhouse reaches it, Decision 9), it
 * only *reads* DOM state — `isConnected` and the element's own key names — and it dispatches
 * no event and writes nothing. The rule the `page.evaluate` ban exists for is the opposite
 * thing: `apply-altana.js` set values and fired synthetic `input` events, which left React's
 * own state untouched. Reading whether React has attached itself is how this avoids that
 * mistake, not a way back into it. The scan in `greenhouse.test.ts` still forbids `evaluate`
 * on `page` and on `root`; the handle's own `h.evaluate` is a different receiver.
 *
 * The fill's wall-clock budget, and the arithmetic behind it (Decision 12).
 *
 * The MCP kills a `run_code` request at a fixed 60 s and returns nothing at all, so a script
 * that runs long costs the whole turn and reports no field it did fill. 30 s is the deadline
 * the loop checks; the bound is what the worst tail *after* a check that passed at 30.0 s
 * costs. That tail is a twin textarea — `2 × click 2000` for the two "Enter manually" probes,
 * `+ waitFor 3000` for the mount, `+ waitFor 1000` for the `attached` presence check that now
 * sits between the mount and the fill, `+ fill 5000` = 13 s — so 43 s. Nothing else comes
 * close, and no two of these can be the same field: a select's tail is `click 5000 +
 * fill 5000` plus the settle's 200 ms = 10.2 s for one option, and 4 s for the read-back; a
 * checkbox group's is one pass of its own loop, `getAttribute 1000 + innerText 1000 +
 * check 3000 + isChecked 1000` = 6 s, because `over()` is checked at the top of every pass;
 * and the confirmation pass's own (2 s read + 5 s fill + 2 s read = 9 s) is shorter again.
 * The menu poll that follows the typing adds next to nothing: `count()` does not wait, and
 * the `over()` gate breaks the loop as soon as the deadline is crossed. That gate sits
 * *before* the pause rather than after it, so one 250 ms wait can straddle the line; the rest
 * of the poll's 2 s ceiling is spent from the budget rather than after it.
 *
 * An upload's retries (Decision 14) do not lengthen that tail. One attach costs
 * `setInputFiles 5000 + 2 × waitFor 1500` = 8 s, and the second and third are gated on
 * `over()` — a run that crosses 30 s inside its first attach makes no further attempt — so the
 * worst an upload can cost after a check that passed is the retry's own 1 s pause, one attach,
 * and the 1 s `-error` read the give-up makes: 10 s, under the twin's 13 s and mutually
 * exclusive with it. Attaching the files last does move them: up to three attaches, with their
 * waits, now run between the last text `fill` and the read-back pass that confirms it, so a
 * run that returns `deadline` is likelier to be reporting a text value on the strength of the
 * `fill` alone. The `over()` gates on both loops are what hold that inside the same bound.
 *
 * The settle spends from the same budget and is not checked against it — `over()` is not
 * consulted inside that loop, because a form that has not settled is not a form to type into
 * whatever the clock says. Its own worst case is three attempts of `waitFor 4000 +
 * waitForFunction 6000 + hold 1500` = 34.5 s, and the slowest run that still types nothing is
 * the one that settles just past 30 s: every answer is then `skipped` as "out of time" at the
 * loop's first check, and nothing at all follows. That path returns `deadline` with an empty
 * `filled` — a reported failure inside the request, which is the whole point of having a
 * deadline.
 *
 * Stated upper bound 43 s: under AC 10's 50 s, well under the MCP's 60 s.
 */
const FILL_BODY = `const filled = [], skipped = [], errors = [];
const why = (e) => String(e && e.message || e), res = (ok, r, f) => ({ ok, filled, skipped, validation_errors: errors, reason: r, frame: ${FRAME}, frames: f }), bail = (r, f) => res(false, r, f);
${PICK}
let root = page;
const t0 = Date.now(), over = () => Date.now() - t0 > 30000;
try {
${REPICK}
if (${OFF_JOB}) return bail(${WRONG_PAGE});
const anchor = () => root.locator("input#first_name, input#email").first();
let anchored = false, late = false, saw = false;
for (let i = 0; i < 3 && !anchored; i++) {
if (i) root = pick();
try { await anchor().waitFor({ state: "visible", timeout: 4000 }); } catch (e) { continue; }
saw = true;
let was = root.url(), h;
try { h = await anchor().elementHandle({ timeout: 2000 }); } catch (e) { continue; }
try { await root.waitForFunction((n) => n.isConnected && Object.keys(n).some((k) => k.indexOf("__react") === 0), h, { timeout: 6000, polling: 500 }); } catch (e) {}
await page.waitForTimeout(1500);
try { anchored = was === root.url() && await h.evaluate((n) => n.isConnected); } catch (e) {}
}
if (!anchored) return bail(saw ? "form not settled" : "form not found", page.frames().map((f) => f.url().slice(0, 100)).slice(0, 6));
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
const clip = (v) => Array.isArray(v) ? v.map(clip) : String(v).slice(0, 120);
const texts = [];
for (const a of data.answers) {
const of = (o) => ({ id: a.id, label: a.label, ...o }), hit = (v) => filled.push(of({ value: clip(v) })), bad = (m) => errors.push(of({ error: m })), skip = (r) => skipped.push(of({ reason: r }));
if (over()) { skip("out of time"); late = true; continue; }
try {
const el = root.locator(a.selector);
if (a.type === "input_file") {
const p = a.id === "resume" ? data.resumePath : a.value;
if (!p) { skip("no file path given"); continue; }
const base = String(p).split("/").pop(), wrap = el.locator('xpath=ancestor::*[contains(@class,"file-upload")][1]');
let seen = false;
for (let i = 0; i < 3 && !seen; i++) {
if (i) { if (over()) break; await page.waitForTimeout(1000); }
try { await el.setInputFiles(p, { timeout: 5000 }); } catch (e) {}
for (const r of [wrap, root]) {
try { await r.locator(".file-upload__filename", { hasText: base }).first().waitFor({ state: "visible", timeout: 1500 }); seen = true; break; } catch (e) {}
}
}
if (seen) { hit(p); continue; }
let said = "";
try { said = (await wrap.locator('[id$="-error"]').first().innerText({ timeout: 1000 })).trim().slice(0, 120); } catch (e) {}
bad("upload not confirmed" + (said ? ": " + said : ""));
continue;
}
if (a.twinOf && !(await el.count())) {
for (const r of [root.locator(a.twinFile).locator('xpath=ancestor::*[.//button][1]'), root]) {
try { await r.locator('button:has-text("enter manually"), [role=button]:has-text("enter manually")').first().click({ timeout: 2000 }); break; } catch (e) {}
}
await el.waitFor({ state: "visible", timeout: 3000 });
}
const want = Array.isArray(a.value) ? a.value : [a.value];
if (a.groupSelector && !(await el.count())) {
const cb = root.locator(a.groupSelector), n = await cb.count();
if (n) {
const got = [];
for (let i = 0; i < n; i++) {
if (over()) break;
const one = cb.nth(i), cid = await one.getAttribute("id", { timeout: 1000 });
let text = "";
try { text = (await root.locator('label[for="' + String(cid).replace(/"/g, "") + '"]').first().innerText({ timeout: 1000 })).trim(); } catch (e) {}
if (!want.some((w) => norm(w) === norm(text))) continue;
try { await one.check({ timeout: 3000 }); } catch (e) {}
if (await one.isChecked({ timeout: 1000 })) got.push(text);
}
if (over()) { bad("out of time"); late = true; }
else if (want.every((w) => got.some((g) => norm(g) === norm(w)))) hit(want);
else bad("checked '" + got.join(", ") + "' instead of '" + want.join(", ") + "'");
continue;
}
}
try { await el.waitFor({ state: "attached", timeout: 1000 }); } catch (e) { skip("not on page"); continue; }
if (a.type.indexOf("select") < 0) {
await el.fill(a.value, { timeout: 5000 });
texts.push([el, a]);
hit(a.value);
continue;
}
for (const option of want) {
if (over()) break;
await el.click({ timeout: 5000 });
await el.fill(option, { timeout: 5000 });
for (let w = 0; w < 8 && !(await root.locator(".select__option").count()); w++) { if (over()) break; await page.waitForTimeout(250); }
await page.keyboard.press("Tab");
await page.waitForTimeout(200);
}
if (over()) { bad("out of time"); late = true; continue; }
const box = el.locator('xpath=ancestor::*[contains(@class,"select__control")][1]'), multi = a.type === "multi_value_multi_select";
let got = [];
try { got = multi ? await box.locator(".select__multi-value__label").allInnerTexts() : [await box.locator(".select__single-value").innerText({ timeout: 2000 })]; }
catch (e) { if (!multi) got = [await el.inputValue({ timeout: 2000 })]; }
const un = a.type === "unlisted_select", sv = (got[0] || "").trim();
if (un ? !sv || norm(sv).indexOf(norm(want[0])) < 0 : want.some((w) => !got.some((g) => norm(g) === norm(w)))) bad("selected '" + got.join(", ") + "' instead of '" + want.join(", ") + "'");
else hit(un ? sv : multi ? want : want[0]);
} catch (e) {
bad(why(e));
}
}
for (const [el, a] of texts) {
if (over()) { late = true; break; }
let ok = false;
for (let i = 0; i < 2 && !ok; i++) {
try { if (i) await el.fill(a.value, { timeout: 5000 }); ok = norm(await el.inputValue({ timeout: 2000 })) === norm(a.value); } catch (e) {}
}
if (!ok) { filled.splice(filled.findIndex((x) => x.id === a.id), 1); errors.push({ id: a.id, label: a.label, error: "value did not stick" }); }
}
return res(!errors.length && !late, late ? "deadline" : undefined);
} catch (e) {
return bail(why(e));
}`;

/**
 * The script that fills one Greenhouse application form.
 *
 * It resolves the document it is working in, checks it is on `jobId`'s posting before it
 * touches a single locator, and then refuses to walk the answers at all until it has seen a
 * field it recognises: `input#first_name, input#email` is the anchor every Greenhouse
 * application form carries, and three tries at four seconds each — re-resolving the root
 * between them, because the embed can still be mounting — are the difference between "the
 * form is somewhere this script cannot see" and thirty selectors that each wait their own
 * timeout out against nothing. A run that never finds it returns `form not found` with the
 * URL of every frame the page was showing, which is what a human needs in order to see why.
 *
 * Once anchored it walks the answers. Each answer is a step of its own inside its own
 * try/catch, so a selector that has gone stale costs one field rather than the whole form,
 * and each step is gated on the 30 s deadline: the fields past it are `skipped` with
 * "out of time" and the whole result comes back with `reason: "deadline"`, because a partial
 * result the caller can read beats a request the MCP kills at 60 s with nothing in it.
 *
 * A file field uploads and then *waits to see it*. `setInputFiles` resolves as soon as the
 * file is attached to the input, which is not the same as Greenhouse having accepted it: the
 * page POSTs the bytes to S3 and only then swaps a `.file-upload__filename` node in where the
 * input was. Reporting `filled` on the strength of `setInputFiles` alone is the optimistic
 * row that made a failed upload look like an attached resume, so after each attach the script
 * polls for three seconds — inside the field's own `.file-upload` wrapper first, page-wide as
 * a fallback for boards that render the filename outside it — for a node carrying the basename.
 * Only the `resume` field uploads `resumePath`, the path the caller resolved from the
 * profile, and it overrides whatever the model wrote; every other file field (amplitude's
 * optional `cover_letter`, say) uploads its own answer, because sending the resume PDF as
 * someone's cover letter is worse than sending nothing. An empty path is `skipped` either way.
 *
 * An attach that never confirms is retried, and the files are attached last (Decision 14).
 * Greenhouse's drop zone routes a change event through an `uploaders` map that an async
 * `presigned_fields` fetch fills in after hydration; fire the event before that lands and the
 * handler throws `Cannot read properties of undefined (reading 'uploadFile')` and nothing is
 * uploaded at all. The first live embedded run reached the resume sixth, about two seconds
 * after hydration, and lost it exactly that way. So every text and select field is filled
 * first — free time for the fetch — and the attach is made up to three times, each retry a
 * second after the last one's three seconds of looking came up empty. That is far longer than
 * the fetch has ever taken, and it costs nothing at all when the first attach works. A run
 * that has crossed its deadline makes no further attempt. An attach that *throws* costs the
 * attempt and nothing more: Greenhouse unmounts the input the instant a file lands, so a fill
 * re-run over a resume it already took finds no input to set at all, and swallowing that lets
 * the confirmation pass — which runs either way — find the filename the page is still showing
 * and report `filled`, instead of a raw Playwright timeout reaching `validation_errors`.
 *
 * A give-up quotes the page rather than guessing: Greenhouse renders the handler's own message
 * into an `<id>-error` node inside the field's wrapper, so the `validation_errors` entry reads
 * `upload not confirmed: <that text>` when there is one and `upload not confirmed` when there
 * is not. It leaves the result's `reason` alone even when the deadline is what stopped the
 * retries — the field is carrying its own error, and `deadline` stays reserved for answers the
 * loop never reached at all.
 *
 * A twin — the `<name>_text` textarea that shadows a file upload — is not in the DOM until
 * the applicant asks for it: Greenhouse renders the drop zone with an "Enter manually" button
 * beside it and mounts the textarea only on click. So when a twin's selector matches nothing,
 * the script clicks that button first, looking for it inside the twin's own field group (the
 * nearest ancestor of the parent file input that holds a button) and falling back to the
 * first one on the page. Both lookups failing is one `validation_errors` entry and the loop
 * carries on, which is the same treatment any other unreachable field gets.
 *
 * A select is driven with the react-select keyboard dance — click, type the label, wait for
 * the menu, Tab — and never with `page.evaluate` plus a synthetic `input` event:
 * `apply-altana.js` tried that to "bypass React event issues" and it left React's own state
 * unchanged, which is why the `apply-altana-full.js` rewrite went back to real keyboard events.
 *
 * Tab alone, with no ArrowDown before it. react-select focuses option 0 the moment the menu
 * opens, so an ArrowDown moves *off* the best match and onto the one after it. Live on
 * `job-boards.greenhouse.io/mozilla/jobs/7947405`, typing `San Francisco` into the location
 * combobox returned six geocoder options with `San Francisco, California, United States`
 * first, and ArrowDown + Tab committed `San Francisco de Macorís, Duarte, Dominican
 * Republic` — the second. Every other select had been masked from this because the dance
 * types an exact option label, which usually narrows the menu to a single entry.
 *
 * The wait is a poll rather than a sleep, because the fixed 300 ms it replaced was too short:
 * that same combobox's menu was empty at +605 ms and populated at +1,009 ms. Eight polls at
 * 250 ms is a 2 s ceiling, comfortably over that round trip, and it is gated on `over()` so a
 * board whose menu never opens spends the fill's deadline no faster than any other field
 * does. Only one react-select menu is open at a time, so an unscoped `.select__option` count
 * under `root` is unambiguous; scoping it to the control would cost bytes for no accuracy.
 *
 * Tab, not Enter, is what confirms the option. react-select's Enter handler returns without
 * calling `preventDefault` when no option is focused, and the keydown then reaches the form
 * and submits it — the live run's own ad-hoc script ended an application that way. A re-run
 * over a multi-select that already holds its chips is precisely that state, because a selected
 * option is hidden from the menu and there is nothing left for the poll to see. Tab selects
 * the focused option (`tabSelectsValue` defaults to true) and merely moves focus when there
 * is none, so the worst a re-run can do is leave the field as it found it.
 *
 * After the dance the script reads the choice back out of the react-select container — the
 * multi-value chips or the single value, on one code path — and reports a mismatch as a
 * `validation_errors` entry rather than as a fill, because the dropdown's first suggestion is
 * not always the label that was typed.
 *
 * An `unlisted_select` is read back by containment rather than by equality (Decision 15). The
 * `Location (City)` control is a react-select whose options the Job Board API does not
 * enumerate, so its answer is a city name typed at a geocoder rather than a label copied off
 * a list, and the geocoder answers with something fuller: `San Francisco` resolves to `San
 * Francisco, California, United States`. The answer is a substring of the result and never
 * the reverse, so the check is that the control now holds something containing what was asked
 * for — and what goes into `filled[]` is what the page holds, not what was asked, so the model
 * can see which city Greenhouse picked and stop to ask when it is the wrong one.
 *
 * There is no `country` question and no `#country` fill path. The page's `input#country`
 * is the phone widget's dial-code selector, not an address field — its only "United States"
 * option is `United States +1`, and picking it reformats `phone`. A synthesized `country`
 * question aimed at that control, and the hardcoded `#country` probe before it, both tried to
 * answer it and both were removed; the control is left alone.
 *
 * A `multi_value_multi_select` gets a second path, because some boards render one as a group
 * of checkboxes sharing a `name` rather than as a react-select. It is a fallback and not a
 * choice: the group is reached only when the combobox matches nothing at all, which keeps the
 * react-select the preferred path on every board that has one. The group's selector is built
 * in `answers.ts` from the same validated id every other selector goes through (Decision 9),
 * and each box's option text is read off its `<label for>`, since a checkbox carries no
 * wording of its own. `check()` is idempotent, which is what makes this path safe to re-run
 * over a form that already holds its answers (Decision 14) — and there is no keypress in it
 * at all, so it cannot submit anything. A box whose id or label cannot be read is passed over
 * rather than guessed at, and an answer whose options the group did not turn out to hold is a
 * `validation_errors` entry naming both what was checked and what was asked for, so the model
 * can recover without re-reading the form.
 *
 * A deadline that truncates that loop reports `out of time` and sets `late`, in the select
 * loop's own words and for the same reason. The two messages mean opposite things: `out of
 * time` (and so `reason: "deadline"`) says the answer was never typed and the script should
 * simply be re-run, while a `checked '…' instead of '…'` says the answer itself is wrong and
 * sends the caller off fixing one that was fine. Falling through to the comparison with a
 * half-built `got` would say the second when it meant the first — and only when the group is
 * the last answer, since anything after it makes the answers loop recheck `over()` and set
 * `late` anyway. Checkbox groups sit last on plenty of Greenhouse forms.
 *
 * Throws on an id that could not be used as a selector, and on a job id that is not all
 * digits. Task 5 rejects those ids upstream, so reaching here means the schema was built
 * somewhere other than `compactSchema` — and the one thing this generator must never do is
 * emit a script around an id it cannot vouch for.
 */
export function generateFillScript(
  resolved: ResolvedAnswer[],
  resumePath: string,
  jobId: string,
): string {
  const answers = resolved.map((a) => {
    if (!isValidElementId(a.id)) {
      throw new Error(
        `Refusing to generate a fill script for id ${JSON.stringify(String(a.id)).slice(0, 80)}: an id must be selector-safe.`,
      );
    }
    const entry: Record<string, unknown> = {
      id: a.id,
      label: a.label,
      type: a.type,
      value: a.value,
      selector: a.selector,
    };
    // The checkbox group a `[]` multi-select falls back to, built in `answers.ts` from the
    // same validated id (Decision 9) and carried through untouched, exactly as `selector` is.
    if (a.groupSelector !== undefined) entry.groupSelector = a.groupSelector;
    if (a.twinOf !== undefined) {
      if (!isValidElementId(a.twinOf)) {
        throw new Error(
          `Refusing to generate a fill script for twin parent ${JSON.stringify(String(a.twinOf)).slice(0, 80)}: an id must be selector-safe.`,
        );
      }
      // Both go in: `twinOf` is what makes the entry a twin, and `twinFile` is its parent's
      // selector, built here rather than concatenated inside the template (Decision 9).
      entry.twinOf = a.twinOf;
      entry.twinFile = `input${elementRef(a.twinOf)}[type=file]`;
    }
    return entry;
  });
  // Files go last (Decision 14). Greenhouse's form can only accept an attach once an async
  // presigned_fields fetch has filled its uploaders map, and the first live embedded run
  // reached the resume sixth in order, about two seconds after hydration — inside that
  // window. Every text and select field typed first is time the fetch gets for free.
  const ordered = [...answers.filter((a) => a.type !== "input_file"), ...answers.filter((a) => a.type === "input_file")];
  return script(
    dataLiteral({ answers: ordered, resumePath, jobId: checkedJobId(jobId, "fill") }),
    FILL_BODY,
  );
}

// ── Submit ──

/**
 * Validation errors the page is showing, with whatever names them.
 *
 * The selector is narrow on purpose. A bare `.error` or a page-level `[role="alert"]` also
 * matches a live region reading "Saving your answers", and the caller's answer to
 * `validation_errors` is to fix and re-submit — so a false positive here risks a duplicate
 * application. Only an explicitly invalid field, a field-error node, or an alert *inside the
 * form* counts. The poll also holds this check back for the first two ticks, because the
 * page is still settling for the second after the click.
 *
 * What a match yields is rarely its own text. `[aria-invalid="true"]` is the input, and an
 * `<input>` has no `innerText` at all — Greenhouse keeps the message in a sibling
 * `<p id="<id>-error">` and points the control at it with `aria-errormessage`. Reading the
 * node alone is why the live run's empty required multi-select came back as `unknown` twice
 * with nothing to fix. So a node with no text of its own is followed: to whatever
 * `aria-errormessage` names, or, for the controls that carry no such attribute, to
 * `<its own id>-error`. Only then is emptiness taken at face value — an invisible node's
 * `innerText` is the empty string, so a hidden error template still drops out.
 *
 * That `[id="…"]` locator is built at run time from a DOM attribute, which is inside
 * Decision 9 rather than an exception to it: Decision 9 is about the *generated source*,
 * and this string is used as a locator, never as code. The quotes are stripped so a hostile
 * id cannot close the attribute selector early, and the worst a strange one can do is throw
 * a locator error the surrounding catch swallows.
 *
 * Bare `-error` nodes are deliberately *not* in the selector. Greenhouse never clears
 * `<p id="resume-error">` after a later attach succeeds, so a page holding a stale upload
 * message would come back as a validation error on a form that has nothing wrong with it,
 * and the caller would go round again on an application that was ready to send. A message is
 * only evidence when a control points at it.
 *
 * Two bounds, doing two different jobs. Each node now costs `getAttribute id 1000 +
 * innerText 1000 + getAttribute aria-errormessage 1000 + message innerText 1000 +
 * xpath innerText 1000 + getAttribute aria-label 1000` = 6 s, so a page showing fifty error
 * nodes would spend 300 s here on the *first* tick that runs the check: `nodes.slice(0, 5)`
 * bounds that. The deadline check bounds the *last* tick, where the five admitted nodes would
 * otherwise carry a poll that started at 39.9 s another 30 s past its budget.
 */
const FIELD_ERRORS = `const fieldErrors = async () => {
const out = [];
let nodes = [];
try { nodes = await root.locator('[aria-invalid="true"], .field-error, form [role="alert"]').all(); } catch (e) {}
for (const n of nodes.slice(0, 5)) {
if (Date.now() - t0 > 40000) break;
try {
const id = await n.getAttribute("id", { timeout: 1000 });
let text = (await n.innerText({ timeout: 1000 })).trim();
if (!text) {
const em = (await n.getAttribute("aria-errormessage", { timeout: 1000 })) || (id ? id + "-error" : "");
if (em) try { text = (await root.locator('[id="' + em.replace(/"/g, "") + '"]').first().innerText({ timeout: 1000 })).trim(); } catch (e) {}
}
if (!text) continue;
const item = { error: text.slice(0, 160) };
if (id) item.id = id;
let label = "";
try { label = (await n.locator("xpath=ancestor::label[1]").innerText({ timeout: 1000 })).trim(); } catch (e) {}
if (!label) label = (await n.getAttribute("aria-label", { timeout: 1000 })) || "";
if (label) item.label = label.slice(0, 160);
out.push(item);
} catch (e) {}
}
return out;
};`;

/**
 * The submit's wall-clock budget (Decision 12), same 60 s MCP ceiling as the fill's.
 *
 * 40 s is the poll's deadline, checked in the loop condition and again inside `fieldErrors`.
 * A tick admitted at 39.999 s spends `wait 500 + bodyText 2000 + captcha 2 × 1000` = 4.5 s
 * before it reaches the collector, and by then the collector's own check has expired, so it
 * breaks on its first node. The longer tail is the one where that check passes: a node
 * entered at 40.0 s costs its full 6 s of reads, and the `unknown` tail (`title` + one more
 * `bodyText`) adds about 2 s — 48 s, under AC 10's 50 s and well under the MCP's 60 s.
 */
const SUBMIT_BODY = `${PICK}
let root = page;
const t0 = Date.now();
try {
${REPICK}
if (${OFF_JOB}) return { state: "error", detail: ${WRONG_PAGE} };
${BODY_TEXT}
${SEES_CAPTCHA}
${CONFIRMED}
${FIELD_ERRORS}
const before = await bodyText();
if (await seesCaptcha(before)) return { state: "captcha" };
const preConfirmed = confirmedText(before);
let vanished = false, empty = 0;
${FORM_GONE}
if (await confirmed(before, preConfirmed, vanished)) return {state:"submitted",detail:"already confirmed"};
await root.getByRole("button", { name: "Submit application" }).click({ timeout: 5000 });
for (let i = 0; i < 20 && Date.now() - t0 < 40000; i++) {
await page.waitForTimeout(500);
if (empty >= 2) root = pick();
const body = await bodyText();
empty = body ? 0 : empty + 1;
let boxes = 0;
try { boxes = await root.locator('input[maxlength="1"]').count(); } catch (e) {}
if (boxes || /security code/i.test(body)) return { state: "otp_required" };
if (await seesCaptcha(body)) return { state: "captcha" };
${FORM_GONE}
if (await confirmed(body, preConfirmed, vanished)) return { state: "submitted" };
if (i >= 2) {
const errors = await fieldErrors();
if (errors.length) return { state: "validation_errors", validation_errors: errors };
}
}
let title = "";
try { title = await page.title(); } catch (e) {}
return { state: "unknown", detail: (vanished ? "form gone, nothing confirmed it | " : "") + title + " | " + (await bodyText()).slice(0, 300) };
} catch (e) {
return { state: "error", detail: String((e && e.message) || e) };
}`;

/**
 * The script that submits a filled Greenhouse form. Separate from the fill (Decision 4) so
 * the caller can look at what the fill reported before anything irreversible happens.
 *
 * It resolves the document it is working in, checks it is on `jobId`'s posting, refuses to
 * click while a CAPTCHA is up, reads the page's confirmation wording *before* the click so
 * the poll knows which words were already there, clicks the one "Submit application" button
 * by its accessible name, then polls in half-second steps — twenty of them, and no further
 * than 40 s from the script's own start — for whichever of the four outcomes arrives first:
 * the security-code group (Greenhouse's verification flow is a two-phase submit), a
 * confirmation, visible validation errors, or a CAPTCHA raised by the click itself. A poll
 * that ends with nothing recognisable is reported as `unknown` with the page title and the
 * head of its text, so the caller can look rather than guess. Two consecutive empty body
 * reads mean the frame under it was replaced by a parent-page reload, so the poll re-resolves
 * the root at the start of every tick from then on.
 *
 * The only data it injects is the job id its guard tests against.
 */
export function generateSubmitScript(jobId: string): string {
  return script(dataLiteral({ jobId: checkedJobId(jobId, "submit") }), SUBMIT_BODY);
}

// ── OTP ──

/**
 * The OTP's wall-clock budgets (Decision 12): 20 s before the click, 40 s for the poll.
 *
 * Untimed, the phase before the click can cost `waitFor 5000 + click 5000 + pressSequentially
 * 5000 + read-back (8 × inputValue 2000) + fallback (8 × fill 5000) + a second read-back` ≈
 * 87 s on its own, which is the whole MCP request and then some. Checking 20 s at the top of
 * each read-back and of each fallback fill bounds that at 20 s plus one box action (5 s);
 * the click is 5 s, the poll then runs to 40 s, a tick costs ≤ 4 s and the tail ≈ 2 s — 46 s.
 *
 * The read-back's own check throws rather than returning, because `readBack` returns the
 * string the boxes spell: a result shape returned from it would land in `got` and come back
 * to the caller as `code did not stick: [object Object]`, telling the model its code was
 * rejected when in fact the script ran out of time. The outer catch renders the throw as the
 * same `{ state: "error", detail }` every other exit uses. The fallback fill loop's check is
 * a plain `return`, since that loop sits in the body and returning from it leaves the script.
 */
const OTP_BODY = `${PICK}
let root = page;
const t0 = Date.now();
try {
${REPICK}
if (${OFF_JOB}) return { state: "error", detail: ${WRONG_PAGE} };
const code = String(data.code);
if (!/^[A-Za-z0-9]{4,10}$/.test(code)) return { state: "error", detail: "invalid code" };
const norm = (s) => String(s).trim().toLowerCase();
${BODY_TEXT}
${SEES_CAPTCHA}
${CONFIRMED}
const boxes = root.locator('input[maxlength="1"]');
try { await boxes.first().waitFor({ state: "visible", timeout: 5000 }); } catch (e) { return { state: "error", detail: "no security-code boxes found" }; }
const count = await boxes.count();
const readBack = async () => {
let out = "";
for (let i = 0; i < count; i++) {
if (Date.now() - t0 > 20000) throw new Error("out of time reading the code boxes");
out += await boxes.nth(i).inputValue({ timeout: 2000 });
}
return out;
};
await boxes.first().click({ timeout: 5000 });
await boxes.first().pressSequentially(code, { delay: 40, timeout: 5000 });
await page.waitForTimeout(300);
let got = await readBack();
if (norm(got) !== norm(code)) {
for (let i = 0; i < count; i++) {
if (Date.now() - t0 > 20000) return { state: "error", detail: "out of time reading the code boxes" };
await boxes.nth(i).fill(code[i] || "", { timeout: 5000 });
}
await page.waitForTimeout(300);
got = await readBack();
}
if (norm(got) !== norm(code)) return { state: "error", detail: "code did not stick: " + got };
const preConfirmed = confirmedText(await bodyText());
if (Date.now() - t0 > 20000) return { state: "error", detail: "out of time before submit" };
await root.getByRole("button", { name: "Submit application" }).click({ timeout: 5000 });
let vanished = false, empty = 0;
for (let i = 0; i < 20 && Date.now() - t0 < 40000; i++) {
await page.waitForTimeout(500);
if (empty >= 2) root = pick();
const body = await bodyText();
empty = body ? 0 : empty + 1;
if (await seesCaptcha(body)) return { state: "captcha" };
${FORM_GONE}
if (await confirmed(body, preConfirmed, vanished)) return { state: "submitted" };
}
let title = "";
try { title = await page.title(); } catch (e) {}
return { state: "error", detail: (vanished ? "form gone, nothing confirmed it | " : "no confirmation after the code | ") + title + " | " + (await bodyText()).slice(0, 300) };
} catch (e) {
return { state: "error", detail: String((e && e.message) || e) };
}`;

/**
 * The script that answers Greenhouse's emailed security code and finishes the submission.
 *
 * `code` is injected as data and validated inside the script rather than here, so an
 * unusable code comes back as a result the caller can read instead of as a generator throw
 * in the middle of a half-submitted application. `jobId` is checked here, because a bad one
 * would leave the wrong-page guard vacuous.
 *
 * The primary path types the whole code into the first box and lets the group auto-advance,
 * which is what the boxes actually do (Decision 7); the fallback clears every box and fills
 * one character each, the way `apply-altana-full.js` did it. Either way the script reads all
 * the boxes back and refuses to submit unless they spell the code. It then clicks "Submit
 * application" a second time, because the verification flow re-submits the form — taking the
 * same confirmation-wording baseline before that click as the submit script does.
 */
export function generateOtpScript(code: string, jobId: string): string {
  return script(dataLiteral({ code, jobId: checkedJobId(jobId, "OTP") }), OTP_BODY);
}
