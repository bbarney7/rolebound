import { PROFILE_SECTION_IDS, type ProfileBullet, type ProfileSectionId } from "../shared/types";

/**
 * THE CORRECTNESS CORE — a raw-text locator over `profile.md` plus the three
 * edit primitives every write goes through. Pure: a string in, a string or a
 * description out. NO `fs`, and NO import from `.pi/`.
 *
 * WHY THIS EXISTS AT ALL, given that `.pi/extensions/lib/profile.ts` already
 * parses the same file. That parser is LOSSY BY DESIGN and cannot be the model
 * a write is rendered from:
 *
 *   - `cleanValue` (`profile.ts:120-130`) drops italic-only bullet values, so
 *     `- **GitHub:** *(none — skip if optional…)*` parses to nothing.
 *   - `parseBullets` (`:133-143`) skips every line that is not `- **Key:** value`.
 *   - `parseTable` (`:154-165`) drops the header row unconditionally.
 *   - `## Education`, `## Authorization`, `## Q&A bank` and
 *     `## Address policy reminder` have no parser at all.
 *
 * A writer that regenerated a section from the parsed model would silently
 * delete all four classes of content. So the primitives below only ever splice
 * bullet VALUE runs, or one whole section-body range the user typed.
 *
 * It is also the only thing that can answer "is this section on disk?".
 * `parseCandidateSummary` (`profile.ts:302-331`) SYNTHESISES a summary from
 * Work-history headings when the section is absent, `topics: null` means
 * "absent OR empty", and `resumeRegionRules: []` means "absent OR no usable
 * rows". Presence therefore comes from here, never from `Profile`.
 */

// ── The comment mask ────────────────────────────────────────────────────────

/**
 * `parseProfile:339` strips HTML comments BEFORE splitting, so a bullet or a
 * heading inside `<!-- … -->` is invisible to the agent. The locator has to
 * agree with that while still writing into the real bytes, so it builds a
 * same-length shadow: every byte inside a comment becomes a space, newlines
 * preserved, and `commented[i]` records which ones. Length preservation is what
 * keeps every offset and every 1-based line number exact.
 *
 * The regex is `parseProfile`'s own, so an UNTERMINATED `<!--` is not a comment
 * to either of us.
 */
interface CommentMask {
  masked: string;
  commented: Uint8Array;
}

function buildMask(text: string): CommentMask {
  const commented = new Uint8Array(text.length);
  const re = /<!--[\s\S]*?-->/g;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(last, m.index));
    let blank = "";
    for (let i = 0; i < m[0].length; i++) {
      commented[m.index + i] = 1;
      blank += m[0][i] === "\n" ? "\n" : " ";
    }
    parts.push(blank);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return { masked: parts.join(""), commented };
}

/** Offsets of the first character of every line, `split("\n")`-compatible. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** End offset of the line beginning at `starts[i]`, exclusive of its newline. */
function lineEndAt(text: string, starts: number[], i: number): number {
  return i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
}

/**
 * The line with masked bytes REMOVED — not spaced.
 *
 * SPACING ALONE DIVERGES FROM THE PARSER ON A REAL INPUT, and heading detection
 * has to compensate. `parseProfile` *removes* comment bytes (`profile.ts:339`),
 * so `<!-- note -->## Resume` collapses to `## Resume` at column 0 and IS a
 * heading to the agent; a same-length mask leaves twelve spaces in front of the
 * `#` and the anchored `/^(#{1,6})\s+/` (`splitSections:83`) would not match.
 * So every "is this a heading" question runs on this, while body offsets keep
 * using the spaced mask, where length preservation is what matters.
 */
function commentRemovedLine(text: string, mask: CommentMask, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    if (!mask.commented[i]) out += text[i];
  }
  return out;
}

/** Offset of the first byte on the line that is not inside a comment. */
function firstUncommented(mask: CommentMask, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (!mask.commented[i]) return i;
  }
  return start;
}

// ── The locator ─────────────────────────────────────────────────────────────

export interface SectionSpan {
  level: number;
  /** heading text AS IT APPEARS ON DISK, comments and all — what the UI shows */
  heading: string;
  /** 1-based line number of the heading */
  line: number;
  /** offset of the first uncommented `#` */
  headingStart: number;
  /** offset just past the heading line, exclusive of its newline */
  headingEnd: number;
  /** offset of the line after the heading */
  bodyStart: number;
  /** to the next heading of ANY level — matches `Section.body` */
  bodyEnd: number;
  /** to the next heading of the SAME OR HIGHER level — matches `Section.bodyWithSubsections` */
  bodyWithSubsectionsEnd: number;
}

/**
 * One entry per heading line, matched on the comment-removed line with the same
 * expression `splitSections:83` uses.
 *
 * Both body ends are carried because both are needed: Identity's bullets live
 * in `body`, while the Q&A bank's textarea is `bodyWithSubsections` so its two
 * `###` subsections round-trip through the textarea rather than being orphaned
 * outside it (Q2).
 */
export function indexSections(md: string): SectionSpan[] {
  const mask = buildMask(md);
  const starts = lineStarts(md);
  const heads: Array<{ level: number; span: SectionSpan; lineIndex: number }> = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = lineEndAt(md, starts, i);
    const removed = commentRemovedLine(md, mask, start, end);
    const m = removed.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const headingStart = firstUncommented(mask, start, end);
    heads.push({
      level: m[1].length,
      lineIndex: i,
      span: {
        level: m[1].length,
        heading: md.slice(headingStart, end).replace(/^#{1,6}\s*/, "").trim(),
        line: i + 1,
        headingStart,
        headingEnd: end,
        bodyStart: i + 1 < starts.length ? starts[i + 1] : md.length,
        bodyEnd: md.length,
        bodyWithSubsectionsEnd: md.length,
      },
    });
  }

  return heads.map((h, idx) => {
    const nextAny = heads[idx + 1];
    let sameOrHigher: (typeof heads)[number] | undefined;
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        sameOrHigher = heads[j];
        break;
      }
    }
    return {
      ...h.span,
      bodyEnd: nextAny ? starts[nextAny.lineIndex] : md.length,
      bodyWithSubsectionsEnd: sameOrHigher ? starts[sameOrHigher.lineIndex] : md.length,
    };
  });
}

/**
 * A RE-STATEMENT of `.pi/extensions/lib/profile.ts:105-111`, which is not
 * exported. That is the definition this must track; the parity cases in
 * `__tests__/profileText.test.ts` (9.20–9.23) are the drift guard.
 *
 * The comment removal is the one addition, and it is not optional. The parser
 * strips every comment at `:339` BEFORE `splitSections` ever sees a heading, so
 * by the time its `normalizeHeading` runs there are none left. This one runs on
 * raw disk text, so `## Resume <!-- ask first -->` would normalize to
 * `resume ask first` and the exact `h === "resume"` matcher (`profile.ts:245`)
 * would fail where the agent's succeeds.
 */
export function normalizeHeading(heading: string): string {
  return heading
    .replace(/<!--[\s\S]*?-->/g, "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * One predicate per section id, each copying the parser's own so the UI and the
 * agent can never disagree about which heading is which section. The five with
 * no parser upstream are ours.
 *
 * `## Q&A bank` normalizes to `q a bank` (the `&` collapses to a space), which
 * is why that matcher accepts both spellings.
 */
const SECTION_MATCHERS: Record<ProfileSectionId, (normalized: string) => boolean> = {
  // profile.ts:204
  identity: (h) => h === "identity" || h.startsWith("identity"),
  // profile.ts:245 — exact, so `### Resume region rules` must not match
  resume: (h) => h === "resume",
  // profile.ts:251
  resumeRegionRules: (h) => h.includes("resume region rules") || h.includes("resume key"),
  // profile.ts:263
  cityRules: (h) => h.includes("address rules") || h.includes("city address"),
  // no parser upstream
  cityNormalization: (h) => h.includes("city normalization"),
  // profile.ts:315
  workHistory: (h) => h.includes("work history") || h.includes("experience"),
  // no parser upstream
  education: (h) => h.includes("education"),
  // no parser upstream
  authorization: (h) => h.includes("authorization"),
  // no parser upstream
  qaBank: (h) => h.includes("q a bank") || h.includes("qa bank"),
  // profile.ts:291
  searchPreferences: (h) => h.includes("job search preferences") || h.includes("search preferences"),
  // profile.ts:309
  candidateSummary: (h) => h.includes("candidate summary") || h.includes("gatherer summary"),
  // no parser upstream
  addressPolicy: (h) => h.includes("address policy"),
};

/** The FIRST matching span, matching `findSection:113-115`'s `Array.find`. */
export function findSectionIn(spans: SectionSpan[], id: ProfileSectionId): SectionSpan | null {
  const match = SECTION_MATCHERS[id];
  return spans.find((s) => match(normalizeHeading(s.heading))) ?? null;
}

export function findSection(md: string, id: ProfileSectionId): SectionSpan | null {
  return findSectionIn(indexSections(md), id);
}

// ── Bullets ─────────────────────────────────────────────────────────────────

/**
 * ONE SCAN, TWO CONSUMERS — this is what makes the round-trip exact.
 *
 * `ScannedBullet` is MODULE-PRIVATE and carries the value-run offsets; the wire
 * type `ProfileBullet` is derived from it by dropping them. `readBullets` is
 * `scanBullets(...).map(toProfileBullet)`, and `setBulletValues` splices
 * `[valueStart, valueEnd)` from that same scan — so "the writer splices exactly
 * the run the reader returned" is true by construction rather than by two
 * regexes agreeing. `valueEnd` is where the trailing-comment rule lives, and
 * because both sides read it from one place there is no symmetry to maintain by
 * hand.
 */
interface ScannedBullet {
  key: string;
  label: string;
  value: string | null;
  valueStart: number;
  valueEnd: number;
  /** offset just past the bullet's line, exclusive of its newline */
  lineEnd: number;
}

/**
 * Every bullet line in `span.body`, matched with `parseBullets:136`'s regex
 * VERBATIM — but run against the SPACED mask rather than the raw line.
 *
 * That is what makes a fully commented-out bullet invisible (the whole line
 * becomes spaces, so `^\s*[-*]` cannot match) while a bullet the parser DOES
 * see through a leading comment — `<!-- note -->- **Key:** v` — still scans,
 * exactly as it does for the agent. The offsets index the original bytes,
 * because the mask is the same length.
 */
function scanBullets(md: string, span: SectionSpan, mask: CommentMask): ScannedBullet[] {
  const starts = lineStarts(md);
  const out: ScannedBullet[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (start < span.bodyStart) continue;
    if (start >= span.bodyEnd) break;
    const end = lineEndAt(md, starts, i);
    const maskedLine = mask.masked.slice(start, end);
    const m = maskedLine.match(/^\s*[-*]\s+\*\*(.+?)\*\*[:：]?\s*(.*)$/);
    if (!m) continue;

    // The bold run, taken from the RAW bytes so the displayed label is what is
    // on disk. `m[0]` is the whole line (the regex is anchored at both ends),
    // so `m[1]` begins two characters past the first `**`.
    const boldOpen = maskedLine.indexOf("**");
    const labelStart = start + boldOpen + 2;
    const rawLabel = md.slice(labelStart, labelStart + m[1].length);
    const label = rawLabel.replace(/[:：]\s*$/, "").trim();

    // THE VALUE RUN ENDS AT THE MASK, NOT AT THE NEWLINE.
    // `- **Email:** old <!-- ask before changing -->` is a legal bullet and
    // AC 4 requires that comment to survive a save; splicing to end-of-line
    // would eat it. So the run stops at the first byte the mask reports as
    // commented, and the commented tail is left in place verbatim.
    const valueStart = start + maskedLine.length - m[2].length;
    let valueEnd = end;
    for (let j = valueStart; j < end; j++) {
      if (mask.commented[j]) {
        valueEnd = j;
        break;
      }
    }
    const run = md.slice(valueStart, valueEnd);
    out.push({
      key: label.toLowerCase(),
      label,
      value: run === "" ? null : run,
      valueStart,
      valueEnd,
      lineEnd: end,
    });
  }
  return out;
}

function toProfileBullet(b: ScannedBullet): ProfileBullet {
  return { key: b.key, label: b.label, value: b.value };
}

/** What `readers/profile.ts` calls: the same scan, with the offsets dropped. */
export function readBullets(md: string, span: SectionSpan): ProfileBullet[] {
  return scanBullets(md, span, buildMask(md)).map(toProfileBullet);
}

/**
 * Raw count of data rows in the section's markdown table — every `|`-leading,
 * non-separator line minus the header, exactly the rows `parseTable:154-165`
 * hands its caller before that caller starts skipping them.
 *
 * The diagnostic this exists for: `parseCityRules` drops the `default` row
 * (`profile.ts:271`) and any row with no city (`:281`), so `cityRules.length`
 * can be smaller than what the user typed, and the tab has to be able to say
 * so rather than quietly showing fewer rows.
 */
export function countTableRows(md: string, span: SectionSpan): number {
  const mask = buildMask(md);
  const starts = lineStarts(md);
  let rows = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (start < span.bodyStart) continue;
    if (start >= span.bodyEnd) break;
    const trimmed = mask.masked.slice(start, lineEndAt(md, starts, i)).trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows++;
  }
  return rows > 1 ? rows - 1 : 0;
}

// ── Edit results ────────────────────────────────────────────────────────────

/**
 * Every expected failure is DATA, never a throw: `app.ts` has no trailing error
 * handler (`:53-63` answers `entity.parse.failed` alone), so a throw becomes
 * Express's HTML 500, which a save form can only render as a bare status line.
 *
 * `SECTION_EXISTS` and `EXISTS` are two codes for two different things that
 * both happen to be 409 — "that section is already in the file" and
 * "profile.md is already on disk".
 */
export type ProfileWriteErrorCode =
  | "CONFLICT"
  | "NO_PROFILE"
  | "NO_SECTION"
  | "SECTION_EXISTS"
  | "NO_TEMPLATE"
  | "EXISTS"
  | "BAD_BODY";

export interface ProfileWriteError {
  code: ProfileWriteErrorCode;
  message: string;
}

export type TextEditResult = { ok: true; text: string } | { ok: false; error: ProfileWriteError };

const NO_SECTION: ProfileWriteError = {
  code: "NO_SECTION",
  message: "section not found in profile.md",
};

interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping splices right-to-left so earlier offsets stay valid. */
function applySplices(md: string, splices: Splice[]): string {
  let out = md;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

// ── The three edit primitives ───────────────────────────────────────────────

/**
 * Splice bullet VALUES only — the run between `:** ` and the end of the line,
 * stopping short of a trailing HTML comment. Everything else on the line, and
 * every other line in the file, is untouched by construction.
 *
 * `null` writes the empty string and KEEPS the line (Q6: the bullet, its label
 * and its position all survive, so re-typing restores it). A key absent from
 * the section appends a new `- **<Label>:** <value>` line after the last bullet,
 * or at the section end when there are none.
 *
 * No trimming, on purpose (Q4): the writer stores raw text and `cleanValue`
 * does the trimming on the read side. Trimming here would silently alter a
 * value the user typed and break the byte-level round-trip claim.
 */
export function setBulletValues(
  md: string,
  id: ProfileSectionId,
  values: Record<string, string | null>,
): TextEditResult {
  const mask = buildMask(md);
  const span = findSectionIn(indexSections(md), id);
  if (!span) return { ok: false, error: NO_SECTION };

  const scanned = scanBullets(md, span, mask);
  const splices: Splice[] = [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const wanted = key.trim().toLowerCase();
    const hit = scanned.find((b) => b.key === wanted);
    if (hit) {
      splices.push({ start: hit.valueStart, end: hit.valueEnd, text: value ?? "" });
      continue;
    }
    appended.push(`- **${key}:** ${value ?? ""}`);
  }

  if (appended.length > 0) {
    const last = scanned[scanned.length - 1];
    if (last) {
      // After the last bullet's line. When that line is the file's last and has
      // no newline of its own, the separator has to come first.
      const atEol = last.lineEnd >= md.length;
      splices.push({
        start: atEol ? md.length : last.lineEnd + 1,
        end: atEol ? md.length : last.lineEnd + 1,
        text: atEol ? `\n${appended.join("\n")}` : `${appended.join("\n")}\n`,
      });
    } else {
      const atEol = span.bodyEnd >= md.length && !md.endsWith("\n");
      splices.push({
        start: span.bodyEnd,
        end: span.bodyEnd,
        text: atEol ? `\n${appended.join("\n")}\n` : `${appended.join("\n")}\n`,
      });
    }
  }

  return { ok: true, text: applySplices(md, splices) };
}

/**
 * Reject a body carrying a top-level heading, detected the way headings are
 * detected everywhere else in this module — on the COMMENT-REMOVED line.
 *
 * A raw `/^#{1,2}\s/` test is not enough: `<!-- note -->## Injected` passes it,
 * and the parser (which strips comments first) then reads a real `##` section.
 * `###`+ is allowed and is exactly what the Q&A bank's own subsections are.
 */
export function hasTopLevelHeading(body: string): boolean {
  const mask = buildMask(body);
  const starts = lineStarts(body);
  for (let i = 0; i < starts.length; i++) {
    const removed = commentRemovedLine(body, mask, starts[i], lineEndAt(body, starts, i));
    if (/^#{1,2}\s/.test(removed)) return true;
  }
  return false;
}

/**
 * Replace one section body wholesale, over the exact
 * `[bodyStart, bodyWithSubsectionsEnd)` range the reader handed the textarea.
 *
 * IDEMPOTENCE IS STRUCTURAL: writing that slice back unchanged produces a
 * byte-identical file, with no normalization step to get wrong.
 *
 * The one guard is the trailing newline. It is applied only when something
 * FOLLOWS the range, which is the only situation the guard exists for — a
 * missing newline there would let the next `## ` heading join the last line.
 * At end-of-file there is nothing to join, and adding a byte would break the
 * round-trip claim on a file that simply has no final newline.
 */
export function replaceSectionBody(md: string, id: ProfileSectionId, body: string): TextEditResult {
  const span = findSectionIn(indexSections(md), id);
  if (!span) return { ok: false, error: NO_SECTION };
  if (hasTopLevelHeading(body)) {
    return {
      ok: false,
      error: {
        code: "BAD_BODY",
        message: "body must not contain a `#` or `##` heading — it would create a new section",
      },
    };
  }
  const followed = span.bodyWithSubsectionsEnd < md.length;
  const text = body !== "" && !body.endsWith("\n") && followed ? `${body}\n` : body;
  return {
    ok: true,
    text: md.slice(0, span.bodyStart) + text + md.slice(span.bodyWithSubsectionsEnd),
  };
}

/**
 * The ids the template declares, IN THE TEMPLATE'S OWN ORDER, derived from
 * `indexSections(templateMd)` at request time rather than from a hardcoded
 * list. That is what makes "in `templates/profile.template.md` order" literally
 * true and undriftable.
 */
function templateOrder(templateMd: string): Array<{ id: ProfileSectionId; span: SectionSpan }> {
  const spans = indexSections(templateMd);
  const found: Array<{ id: ProfileSectionId; span: SectionSpan }> = [];
  for (const id of PROFILE_SECTION_IDS) {
    const span = findSectionIn(spans, id);
    if (span) found.push({ id, span });
  }
  return found.sort((a, b) => a.span.headingStart - b.span.headingStart);
}

/**
 * Copy one whole section out of the template — heading line through
 * `bodyWithSubsectionsEnd` — and insert it before the first section that
 * follows it in the TEMPLATE'S order and is present in `md`, or at end-of-file
 * when none is.
 *
 * WHEN THE FILE'S ORDER DISAGREES WITH THE TEMPLATE'S, THE TEMPLATE WINS AND
 * THE RESULT MAY LOOK OUT OF ORDER. That is deliberate. If a file has
 * `## Candidate summary` before `## Q&A bank`, inserting
 * `## Job search preferences` (whose template successors are Candidate summary,
 * then Address policy) puts it before Candidate summary and hence before Q&A.
 * The alternative — inferring intent from the file's own order — has no
 * defensible rule when the two disagree, and AC 3 says "in
 * `templates/profile.template.md` order".
 */
export function insertSection(
  md: string,
  id: ProfileSectionId,
  templateMd: string,
): TextEditResult {
  if (findSection(md, id)) {
    return { ok: false, error: { code: "SECTION_EXISTS", message: "section already exists" } };
  }
  const order = templateOrder(templateMd);
  const at = order.findIndex((entry) => entry.id === id);
  if (at < 0) {
    return {
      ok: false,
      error: {
        code: "NO_TEMPLATE",
        message: "templates/profile.template.md has no such section",
      },
    };
  }

  const source = order[at].span;
  let block = templateMd.slice(source.headingStart, source.bodyWithSubsectionsEnd);
  if (!block.endsWith("\n")) block += "\n";

  const spans = indexSections(md);
  for (const successor of order.slice(at + 1)) {
    const present = findSectionIn(spans, successor.id);
    if (present) {
      return {
        ok: true,
        text: md.slice(0, present.headingStart) + block + md.slice(present.headingStart),
      };
    }
  }

  const separator = md.length > 0 && !md.endsWith("\n") ? "\n" : "";
  return { ok: true, text: md + separator + block };
}


const LEADING_HTML_COMMENTS = /^(\s*<!--[\s\S]*?-->\s*)+/;

export function candidateSummaryCommentPrefix(sectionBody: string, templateBody = ""): string {
  const m = sectionBody.match(LEADING_HTML_COMMENTS);
  if (m) return m[0];
  const tm = templateBody.match(LEADING_HTML_COMMENTS);
  return tm?.[0] ?? "";
}

export function readCandidateSummaryEditorBody(sectionBody: string): string {
  return sectionBody.replace(LEADING_HTML_COMMENTS, "").trimEnd();
}

export function composeCandidateSummarySectionBody(
  editorBody: string,
  existingSectionBody: string,
  templateSectionBody: string,
): string {
  const prefix = candidateSummaryCommentPrefix(existingSectionBody, templateSectionBody);
  const trimmed = editorBody.trim();
  if (!trimmed) {
    return prefix.endsWith("\n") || prefix.length === 0 ? prefix : `${prefix}\n`;
  }
  const body = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  if (!prefix) return body;
  const gap = prefix.endsWith("\n") ? "" : "\n";
  return `${prefix}${gap}${body}`;
}

export function replaceCandidateSummaryBody(md: string, editorBody: string, templateMd: string): TextEditResult {
  const span = findSectionIn(indexSections(md), "candidateSummary");
  if (!span) return { ok: false, error: NO_SECTION };
  if (hasTopLevelHeading(editorBody)) {
    return {
      ok: false,
      error: {
        code: "BAD_BODY",
        message: "body must not contain a `#` or `##` heading — it would create a new section",
      },
    };
  }
  const existingBody = md.slice(span.bodyStart, span.bodyWithSubsectionsEnd);
  const templateSpan = findSectionIn(indexSections(templateMd), "candidateSummary");
  const templateBody = templateSpan ? templateMd.slice(templateSpan.bodyStart, templateSpan.bodyWithSubsectionsEnd) : "";
  const composed = composeCandidateSummarySectionBody(editorBody, existingBody, templateBody);
  return replaceSectionBody(md, "candidateSummary", composed);
}
