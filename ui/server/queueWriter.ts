import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { isSafeSlug, paths } from "./workspace";
import { normalizeJobFile, readJobFile, type JobFileRecord } from "./readers/jobFiles";
import type { QueueCreateBody } from "../shared/types";
import { withDiscoveredJobFileLock } from "../../.pi/extensions/lib/job-file-lock";
import {
  fileIdentity,
  moveJobFileNoClobber,
  sameFileIdentity,
  type FileIdentity,
} from "../../.pi/extensions/lib/job-files";

/**
 * Frontmatter keys in the gatherer's own emission order
 * (job-gatherer.ts:895-902 emits url, company, title, location, source, match,
 * discovered_at), followed by the UI's two advisory additions. `match` and
 * `discovered_at` are deliberately absent: both are the gatherer's own
 * observations about a job it found, and a UI-authored file has neither.
 */
const FRONTMATTER_KEY_ORDER = [
  "url",
  "company",
  "title",
  "location",
  "source",
  "resume_key",
  "address_city_key",
] as const;

/**
 * Every C0 control character plus DEL, written with \u escapes so the
 * source stays greppable and copy-pasteable. \n (\u000A) and \r (\u000D)
 * are the two that matter — a value containing "\n---\n" would terminate
 * the frontmatter block — and the rest come along because none of them
 * belongs in a single-line YAML scalar.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export interface FieldProblem {
  field: string;
  message: string;
}

/**
 * A value is safe iff serializing it as `k: <value>` and parsing the result
 * with the SAME gray-matter the reader uses either THROWS — the accepted
 * tolerant-parser-only case, e.g. an unquoted colon — or yields back the
 * identical string. Anything else is a value gray-matter would silently
 * REINTERPRET, and reinterpretation is the failure this guard exists to stop:
 * a company literally named `Acme # 1 Robotics` writes correctly to disk and
 * reads back as `Acme`, with no error anywhere.
 *
 * Behavioural, not enumerated. A hand-written token list cannot keep up with
 * YAML's scalar grammar, and the one this replaced was wrong in BOTH
 * directions — it rejected `yes`/`no`/`on`/`off` and `-37signals`, which stay
 * strings, and accepted `0123` (becomes 83, octal), `1_000`, `0x10`, `+12`,
 * `[]`, `{}`, `2026-08-05` (becomes a Date), and `"quoted"` (quotes stripped),
 * every one of which changes type or value. This formulation cannot drift from
 * the reader, because it IS the reader.
 *
 * It probes value.trim(), not value, because trim() is what actually gets
 * emitted: the route trims every field before it reaches the writer, and
 * gray-matter strips trailing whitespace from a plain scalar, so probing the
 * raw string would 400 a title with a trailing space — a shape that is live in
 * jobs/queue/ right now (`title: Engineering Manager, Platform `).
 *
 * THE SECOND ARGUMENT IS LOAD-BEARING AND MUST NOT BE REMOVED. gray-matter
 * 4.0.3 memoizes by input string, and it writes the cache entry BEFORE it
 * parses (index.js:35-47): `matter.cache[file.content] = file` runs, then
 * `parseMatter` throws, leaving a poisoned entry whose `data` is `{}`. Every
 * later `matter(sameString)` then returns that empty object instead of
 * throwing. Measured in-session on the pinned 4.0.3:
 *
 *   call 1 -> THREW: YAMLException
 *   call 2 -> NO THROW; data.k = undefined
 *
 * That turns this predicate non-deterministic for exactly the values the
 * `catch` is meant to ACCEPT: `Remote: United States` is accepted on the first
 * call of a process and rejected on every one after it. It is not theoretical
 * — the route validates a field and then createQueueFile re-validates the same
 * string, so the second call always lost and a colon-bearing location 400'd.
 *
 * `if (!options)` (index.js:36) guards both the cache read and the cache
 * write, so passing any options object opts out of the memo entirely: the
 * probe throws consistently and leaves no entry behind for anyone else.
 * `{}` selects the same defaults as passing nothing, so this is still the
 * reader's parser and the reader's behaviour — just without the memo.
 */
function isSafeFrontmatterValue(value: string): boolean {
  const probe = `---\nk: ${value}\n---\n`;
  try {
    const parsed = matter(probe, {}).data as Record<string, unknown>;
    return typeof parsed.k === "string" && parsed.k === value;
  } catch {
    return true; // strict-invalid but tolerant-parseable — the accepted case
  }
}

/**
 * Frontmatter values are VALIDATED, never escaped or quoted.
 *
 * gray-matter.stringify would quote `location: Remote: United States` — output
 * the gatherer never produces, since writeDiscoveredFile (job-gatherer.ts:
 * 889-916) is a raw template-literal join with no quoting at all — and the UI's
 * own tolerant fallback does NOT strip quotes (jobFiles.ts:67, `data[kv[1]] =
 * kv[2].trim()`), so the quoted form would round-trip into the displayed value
 * as a literal `"…"`. Nine live job files already carry unquoted colons and
 * both parsers survive them.
 *
 * A newline is different in kind. A value containing "\n---\n" terminates the
 * frontmatter block early and silently reinterprets the rest of the document.
 * That is the only real injection hazard in this format and the one thing
 * neither parser can recover from, so it is a hard reject rather than a
 * transformation. Tabs and other C0 characters go with it: rejecting them
 * costs nothing and a tab in YAML indentation is actively hostile.
 *
 * TWO CHECKS, IN THIS ORDER (the control-character check ALONE was proven
 * insufficient):
 *
 *  1. The C0/DEL scan. Kept as a cheap pre-filter for two reasons that are not
 *     redundancy: it produces a specific, actionable message naming newlines
 *     rather than the generic reinterpretation message, and it means an
 *     obviously-hostile value never gets fed to a YAML parser at all.
 *  2. The behavioural probe. Everything the first check lets through is asked
 *     of the real parser.
 */
export function checkFrontmatterValue(field: string, value: unknown): FieldProblem | null {
  if (typeof value !== "string") {
    return { field, message: `${field} must be a string` };
  }
  if (CONTROL_CHARS.test(value)) {
    return {
      field,
      message: `${field} must not contain newlines, tabs, or other control characters`,
    };
  }
  if (!isSafeFrontmatterValue(value.trim())) {
    return {
      field,
      message: `${field} would be reinterpreted by the frontmatter parser rather than read back as text — remove any leading "#", quotes, brackets, or braces, and avoid values that look like a number, a date, or true/false/null`,
    };
  }
  return null;
}

/**
 * Emit the gatherer's exact byte shape: "---", one `key: value` line per
 * present field in FRONTMATTER_KEY_ORDER, "---", then the body, with exactly
 * one trailing "\n" and NO blank line between the closing "---" and the body's
 * first line.
 *
 * The missing blank line is not an oversight — it is a consequence of
 * writeDiscoveredFile's `.filter((l) => l !== "")` (job-gatherer.ts:914),
 * which strips the two `""` spacers the author intended. Verified against
 * jobs/queue/wikimedia-wikimedia-enterprise.md, whose bytes are
 * `---\nurl: …\n…\n---\nATS: greenhouse\n…` ending in exactly one 0x0A.
 * Matching it means every consumer — gray-matter, parseFrontmatterTolerant,
 * and the LLM that actually reads these files — sees exactly one format.
 */
export function serializeQueueFile(fields: Record<string, string>, body: string): string {
  const lines: string[] = ["---"];
  for (const key of FRONTMATTER_KEY_ORDER) {
    const value = fields[key];
    if (value !== undefined && value !== "") lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (trimmedBody) lines.push(trimmedBody);
  return `${lines.join("\n")}\n`;
}

/**
 * job-gatherer.ts:206-210, verbatim. `.pi/` is untracked and absent from the
 * worktree, so there is no import that could share this — the copy is
 * annotated so a future drift is at least findable.
 *
 * Three entries are dead code in the original and are kept anyway for exact
 * fidelity: shortTitle's `.replace(/[^a-z0-9\s-]/g, " ")` runs BEFORE the
 * filter, so "&", "—", "sr.", and "manager," can never survive to be matched.
 */
const TITLE_STOPWORDS = [
  "senior", "sr", "sr.", "staff", "manager", "manager,", "of", "engineering",
  "the", "and", "&", "-", "—", "ai", "ml", "platform", "products", "product",
  "a", "to", "for", "in", "on", "with", "director", "lead", "head",
];

/** job-gatherer.ts:212-224, verbatim. Truncates at 50 characters. */
function shortTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TITLE_STOPWORDS.includes(w));
  let s = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s) {
    // fallback: use the whole title
    s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  return s.slice(0, 50);
}

/** job-gatherer.ts:226-233, verbatim. Truncates at 40 characters. */
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * job-gatherer.ts:235-237. Stated plainly: this will generally NOT reproduce
 * the slug the gatherer would have produced for the same job. The gatherer
 * passes the raw ATS BOARD slug as `company` while writing
 * companyDisplayName(company) into the frontmatter, so the filename slug is
 * not re-derivable from the file's own contents whenever the two differ —
 * hubspotjobs→HubSpot alone accounts for 10 live files. That is accepted, and
 * it is exactly why the seen_urls upsert is keyed by URL: the URL is what
 * stops the gatherer re-discovering the same posting under a different slug.
 */
export function deriveSlug(company: string, title: string): string {
  return `${kebab(company)}-${shortTitle(title)}`;
}

/**
 * Write-side slug rules, deliberately STRICTER than isSafeSlug.
 *
 * isSafeSlug exists to stop a slug escaping <root>/jobs/<dir>/ and is
 * otherwise permissive on purpose, because it must also accept names the
 * applier already wrote by hand (state.json references
 * jobs/queue/0-hackerone-senior-manager-ai-engineering-austin.md). A name the
 * UI CREATES carries two further obligations:
 *
 *  - it must not start with "." — WATCH_IGNORED's dotfile rule
 *    (events.ts:14) would swallow every chokidar event for that file, so the
 *    SSE refresh the whole client depends on would never fire for the row;
 *  - it must contain at least one alphanumeric, so a degenerate derivation
 *    (kebab("!!!") === "") cannot produce a file literally named "-.md".
 *
 * The asymmetry is intended: DELETE still uses the permissive guard, because
 * removing a file that already exists must not be blocked by a rule about how
 * new names are chosen.
 */
export function isWritableSlug(slug: string): boolean {
  return isSafeSlug(slug) && !slug.startsWith(".") && /[A-Za-z0-9]/.test(slug);
}

export type QueueWriteError =
  | { code: "INVALID_SLUG"; slug: string; message: string }
  | { code: "INVALID_VALUE"; field: string; message: string }
  | { code: "EEXIST"; slug: string; message: string };

export type CreateQueueFileResult =
  | { ok: true; slug: string; filePath: string }
  | { ok: false; error: QueueWriteError };

/**
 * Write jobs/queue/<slug>.md, refusing to overwrite.
 *
 * The caller is expected to have trimmed and validated `body` already, but
 * every emitted value is re-checked here anyway: this module is the last line
 * of defence for the one hazard neither frontmatter parser can recover from,
 * and a writer that is only safe when its caller is careful is not safe.
 *
 * The "wx" flag is data-model concurrency rule 4 verbatim — "New-file writes
 * need no lock; refuse to overwrite an existing slug (wx flag)". There is no
 * lock here and there cannot be one: lock.ts:6 requires the locked file to
 * exist, and proper-lockfile canonicalizes the target with fs.realpath before
 * doing anything else, so locking a path that does not yet exist rejects
 * ENOENT. "wx" is what makes the unlocked create safe.
 *
 * On collision this returns EEXIST and the route answers 409. No auto-suffix:
 * writing <slug>-2.md would put two files in the queue for what is usually the
 * same posting, and /apply-next would apply to both.
 */
export async function createQueueFile(
  root: string,
  body: QueueCreateBody,
): Promise<CreateQueueFileResult> {
  const fields: Record<string, string> = {
    url: body.url,
    company: body.company,
    title: body.title,
    location: body.location,
  };
  // Two coupled corrections, both so this function is a real last line of
  // defence rather than one that only works when the router pre-cleans:
  //
  //   1. NORMALIZE HERE TOO. checkFrontmatterValue probes `value.trim()`,
  //      so if we validated the raw value and then serialized the raw value,
  //      a direct caller (a test, a future script) could pass
  //      "Acme  " — probed as "Acme", emitted as "Acme  ". Trimming first
  //      makes the probed value and the emitted value the same string, which
  //      is the property the probe's guarantee actually rests on.
  //   2. A BLANK OPTIONAL IS ABSENT, never a value to validate. Probing ""
  //      serializes `k: ` and matter() returns null, not a string, so the
  //      probe would reject a field the caller left empty. Measured null for
  //      "", " ", "   ", and "\t".
  const optional = (v: string | undefined): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  fields.url = body.url.trim();
  fields.company = body.company.trim();
  fields.title = body.title.trim();
  fields.location = body.location.trim();
  const source = optional(body.source);
  const resumeKey = optional(body.resumeKey);
  const addressCityKey = optional(body.addressCityKey);
  const ats = optional(body.ats);
  if (source !== undefined) fields.source = source;
  if (resumeKey !== undefined) fields.resume_key = resumeKey;
  if (addressCityKey !== undefined) fields.address_city_key = addressCityKey;
  for (const [field, value] of Object.entries(fields)) {
    const problem = checkFrontmatterValue(field, value);
    if (problem) {
      return { ok: false, error: { code: "INVALID_VALUE", field, message: problem.message } };
    }
  }
  if (ats !== undefined) {
    const problem = checkFrontmatterValue("ats", ats);
    if (problem) {
      return {
        ok: false,
        error: { code: "INVALID_VALUE", field: "ats", message: problem.message },
      };
    }
  }

  const slug = body.slug ?? deriveSlug(body.company, body.title);
  if (!isWritableSlug(slug)) {
    return {
      ok: false,
      error: {
        code: "INVALID_SLUG",
        slug,
        message: `the derived filename "${slug}" is not a usable slug — supply an explicit slug`,
      },
    };
  }

  // `ats` becomes an "ATS: x" line that jobFiles.ts:119 parses back out; the
  // free-form body follows it after a blank line, mirroring how the gatherer
  // lays out its own body block.
  const bodyParts: string[] = [];
  // Use the normalized `ats`, not `body.ats` — it is the value that was
  // validated above, and a blank one is absent rather than an empty
  // "ATS: " line.
  if (ats !== undefined) bodyParts.push(`ATS: ${ats}`);
  if (body.body !== undefined && body.body.trim() !== "") bodyParts.push(body.body.trim());
  const text = serializeQueueFile(fields, bodyParts.join("\n\n"));

  const filePath = paths.jobFile(root, "queue", slug);
  const { atomicCreateFile } = await import("../../.pi/extensions/lib/durable-store");
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicCreateFile(filePath, text, { mode: 0o644 });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return {
        ok: false,
        error: { code: "EEXIST", slug, message: `queue slug already exists: ${slug}` },
      };
    }
    throw err;
  }
  return { ok: true, slug, filePath };
}

/**
 * The http(s)-only policy, applied to a value that is about to be persisted
 * into the queue. Kept beside the writer rather than in the route because the
 * writer is the last place that can still refuse, and the route's own read is
 * not the read that matters.
 */
function isPromotableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type PromoteQueueFileResult =
  | { ok: true; slug: string; record: JobFileRecord }
  | {
      ok: false;
      error: {
        /**
         * PARTIAL_CONFLICT expresses the one outcome D34 introduces: the
         * request HALF succeeded, both files now exist, and we deliberately
         * deleted neither. Squeezing it into EEXIST would make the route say
         * "queue slug already exists" about a file this very call created, and
         * squeezing it into a throw would make it a 500 — which reads as "your
         * request did nothing" when in fact the queue file is there.
         */
        code: "NOT_FOUND" | "EEXIST" | "PARTIAL_CONFLICT" | "BAD_URL";
        slug: string;
        message: string;
      };
    };

/**
 * Move jobs/discovered/<slug>.md into jobs/queue/, refusing to clobber.
 *
 * fs.link, NOT fs.rename. fs.rename silently REPLACES an existing destination
 * — verified — and that is the gatherer's live bug: promoteToQueue
 * (job-gatherer.ts:1046) is a bare rename, so promoting a slug that is already
 * queued destroys the queued copy without a word. fs.link fails EEXIST
 * atomically, which gives rename's semantics with no TOCTOU window and no
 * check-then-act gap.
 *
 * THE ROLLBACK IS IDENTITY-CHECKED (D34). The first draft of this function
 * rolled back with an unconditional `fs.unlink(dst).catch(() => {})`, which is
 * a time-of-check/time-of-use bug against a writer the plan itself establishes
 * exists: R3 records that the gatherer promotes with a clobbering fs.rename and
 * honours no lock. The concrete failure is: our link succeeds, the gatherer
 * renames ITS file over dst, our unlink(src) fails, and the "rollback" deletes
 * the gatherer's file.
 *
 * So the source's inode is captured BEFORE the link, and the rollback runs
 * only if the file still at dst is that same inode. A hard link shares the
 * inode, so after a successful fs.link the file at dst IS srcId — and srcId is
 * the only identity we can prove is ours. (Recording dst's identity AFTER the
 * link does not work: a writer can replace dst between the link and the lstat,
 * the snapshot then records the FOREIGN inode, and the later comparison
 * matches it — so the rollback deletes exactly the file the check exists to
 * protect.)
 *
 * What this buys, stated exactly as D34 states it: not atomicity — POSIX has
 * no "unlink if inode matches". It narrows the window from link-to-unlink down
 * to lstat-to-unlink, and it converts a silent wrong-file deletion into a loud
 * PARTIAL_CONFLICT that the route answers 409.
 */
export async function promoteQueueFile(
  root: string,
  slug: string,
): Promise<PromoteQueueFileResult> {
  const src = paths.jobFile(root, "discovered", slug);
  const dst = paths.jobFile(root, "queue", slug);
  try {
    return await withDiscoveredJobFileLock(src, async () => promoteQueueFileLocked(root, slug, src, dst));
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return { ok: false, error: { code: "NOT_FOUND", slug, message: `discovered file not found: ${slug}` } };
    }
    throw err;
  }
}

async function promoteQueueFileLocked(
  root: string,
  slug: string,
  src: string,
  dst: string,
): Promise<PromoteQueueFileResult> {
  let record: JobFileRecord | null = null;
  const moved = await moveJobFileNoClobber(src, dst, {
    validate: async (rawContent, _identity, stat) => {
      record = normalizeJobFile(slug, "discovered", src, rawContent, stat.mtime, stat.ctime);
      if (record.url !== null && !isPromotableUrl(record.url)) {
        return {
          ok: false,
          code: "BAD_URL",
          message: `jobs/discovered/${slug}.md has a url that is not http(s), so it was not promoted. Fix the file's url: value and retry.`,
        };
      }
      return { ok: true };
    },
  });

  if (!moved.ok) {
    let message = moved.message;
    if (moved.code === "NOT_FOUND") message = `discovered file not found: ${slug}`;
    else if (moved.code === "EEXIST") message = `queue slug already exists: ${slug}`;
    else if (moved.code === "PARTIAL_CONFLICT") {
      if (message.includes("not a regular file, so it was not moved")) {
        message = `jobs/discovered/${slug}.md is not a regular file, so it was not promoted. Nothing was changed.`;
      } else if (message.includes("stopped being a regular file")) {
        message = `jobs/discovered/${slug}.md stopped being a regular file while it was being copied, so it was not promoted. Nothing was deleted.`;
      } else if (message.includes("changed while it was being moved")) {
        message = `jobs/discovered/${slug}.md changed while it was being promoted, so jobs/queue/${slug}.md is not the file that was read and validated. Nothing was deleted. Check both files and resolve by hand.`;
      } else if (message.includes("is no longer the file that was read, so it was not removed")) {
        const how = message.includes("was copied") ? "copied" : "linked";
        message = `${slug} was ${how} into jobs/queue/, but jobs/discovered/${slug}.md is no longer the file that was read, so it was not removed. Both files now exist; neither was deleted.`;
      } else if (message.includes("was copied into")) {
        message = `${slug} was copied into jobs/queue/ but jobs/discovered/${slug}.md could not be removed. Both files now exist; neither was deleted.`;
      } else if (message.includes("was linked to")) {
        message = `${slug} was linked into jobs/queue/, but jobs/discovered/${slug}.md could not be removed and jobs/queue/${slug}.md is no longer the file we linked. Both files now exist; neither was deleted.`;
      }
    }
    return { ok: false, error: { code: moved.code, slug, message } };
  }

  if (!record) {
    const st = await fs.stat(dst);
    record = normalizeJobFile(slug, "queue", dst, moved.raw, st.mtime, st.ctime);
  }
  return { ok: true, slug, record };
}

export type RemoveQueueFileResult =
  | { ok: true; record: JobFileRecord }
  | { ok: false; code: "NOT_FOUND" }
  /**
   * The path's identity changed between the read and the unlink (D34): the
   * previous signature was `JobFileRecord | null`, and `null` had to mean both
   * "there was nothing there" (404) and "there was something there but it is
   * not what you asked to delete" (409). Those are different answers and the
   * caller has to be able to tell them apart.
   */
  | { ok: false; code: "CHANGED" };

/**
 * Delete jobs/queue/<slug>.md and return what the path held immediately
 * before the unlink.
 *
 * The read before the unlink is a rule, not a nicety. The operating manual's
 * "look before you overwrite" says: before deleting or replacing a file you
 * didn't create, read it. Returning the record is the only recourse a user has
 * for an irreversible operation with no undo.
 *
 * IDENTITY IS CARRIED THROUGH THE WHOLE OPERATION (D34). The first draft read
 * by pathname and then unlinked by pathname, which is a time-of-check/
 * time-of-use race against a writer the plan establishes exists (R3): the
 * record returned as "what was destroyed" could describe a different inode
 * than the one actually unlinked. So: lstat → read → lstat → compare → unlink,
 * and a changed {dev, ino} pair is a 409 instead of a deletion.
 *
 * lstat, not stat: a symlink planted at the path must be compared as the
 * symlink rather than followed to its target.
 *
 * THE CLAIM, NARROWED, AND THIS WORDING IS BINDING (D34). A replacement can
 * still land between the final lstat and the unlink, so this does NOT claim
 * the returned record provably describes the deleted file. It claims only:
 * the record is what the path held immediately before we unlinked it, and any
 * replacement we can detect turns the request into a 409 instead of a
 * deletion. That is strictly better than the unguarded version and is not a
 * guarantee the filesystem can give without coordination the other writers do
 * not participate in.
 *
 * This deliberately does NOT touch gather_state.json. There is no value in the
 * gatherer's union that means "removed from the queue": "rejected" carries a
 * reject_reason contract and permanently suppresses re-discovery
 * (job-gatherer.ts:471-474), which is not what "I de-prioritized this" means.
 * Known asymmetry, stated rather than absorbed: a removed job whose seen_urls
 * decision is non-"rejected" will not be re-surfaced by the gatherer.
 */
export async function removeQueueFile(
  root: string,
  slug: string,
): Promise<RemoveQueueFileResult> {
  const filePath = paths.jobFile(root, "queue", slug);

  let beforeId: FileIdentity;
  try {
    const beforeStat = await fs.lstat(filePath, { bigint: true });
    beforeId = fileIdentity(beforeStat);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, code: "NOT_FOUND" };
    throw err;
  }

  const record = await readJobFile(root, "queue", slug);
  // readJobFile swallows every error into null (jobFiles.ts:164-166), so a
  // null here means the file went away, or turned into a directory, between
  // the lstat above and the read. Either way there is nothing to return and
  // nothing has been unlinked.
  if (!record) return { ok: false, code: "NOT_FOUND" };

  let afterId: FileIdentity;
  try {
    const afterStat = await fs.lstat(filePath, { bigint: true });
    afterId = fileIdentity(afterStat);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, code: "NOT_FOUND" };
    throw err;
  }

  if (!sameFileIdentity(afterId, beforeId)) {
    // The file at this path is not the file we just read. Unlinking now would
    // destroy something the user never asked about — the applier moves
    // queue→applied mid-request and the gatherer promotes with a clobbering
    // rename, so this is a real interleaving, not a theoretical one.
    return { ok: false, code: "CHANGED" };
  }

  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    // Someone else removed it between the final lstat and the unlink — the
    // applier moves queue→applied mid-request. The outcome the caller asked
    // for has happened either way, but the record is no longer ours to claim.
    if (err?.code === "ENOENT") return { ok: false, code: "NOT_FOUND" };
    throw err;
  }
  return { ok: true, record };
}
