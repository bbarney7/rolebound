import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProfile } from "../../../.pi/extensions/lib/profile";
import { paths } from "../workspace";
import {
  countTableRows,
  findSectionIn,
  indexSections,
  readBullets,
  type SectionSpan,
} from "../profileText";
import { readCandidateSummaryEditorBody } from "../profileText";
import {
  PROFILE_SECTION_IDS,
  type ProfileCityRuleView,
  type ProfilePayload,
  type ProfileSectionInfo,
  type ProfileWorkEntry,
} from "../../shared/types";

/**
 * The root-parameterized read (Decision 3, binding).
 *
 * ONLY THE PURE HALF OF THE PARSER IS REUSED. `parseProfile` and `matchesTerm`
 * come from `.pi/extensions/lib/profile`; `loadProfile`/`loadProfileOrEmpty`
 * are never imported, because they bind `PROFILE_FILE = wsPath("profile.md")`
 * at `profile.ts:66` and `.pi/extensions/lib/workspace.ts:10-14` DELIBERATELY
 * refuses to honour `PI_JOBS_ROOT`. The UI must honour it — fixture testing is
 * the only thing standing between a test and the user's real profile, resumes
 * and ATS logins.
 *
 * Section presence comes from `profileText.ts`, NEVER from the parsed
 * `Profile`: `parseCandidateSummary` synthesises a summary from Work-history
 * headings when the section is absent, so the parser cannot tell absent from
 * empty. AC 3 rests on that distinction.
 */

/** `null` on ENOENT; every other error is rethrown. */
export async function readProfileText(root: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(paths.profile(root));
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("profile.md must be a regular file inside the workspace"), { code: "UNSAFE_PROFILE" });
    return await fs.readFile(paths.profile(root), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors `resolveResumePath` (`.pi/extensions/job-applier.ts:83-85`): an
 * absolute override stands, a relative one joins the workspace root — so
 * `resumes/default.pdf` resolves back INTO the resume directory.
 */
export function resolveOverridePath(root: string, override: string): string {
  return path.isAbsolute(override) ? override : path.join(root, override);
}

function absentSections(): ProfileSectionInfo[] {
  return PROFILE_SECTION_IDS.map((id) => ({ id, heading: null, present: false, line: null }));
}

/**
 * The missing-file warning is `loadProfile`'s OWN string
 * (`.pi/extensions/lib/profile.ts:370-371`), root-parameterized.
 *
 * AC 6 says the banner matches what `/status` prints, and `/status` prints
 * exactly this via `emptyProfile(error)` folding it into `warnings[0]`
 * (`:395`, `:400-403`). Matching it here is what makes the claim true rather
 * than approximate.
 */
export function missingProfileWarning(root: string): string {
  return (
    `No profile.md in the workspace (${paths.profile(root)}). ` +
    "Copy templates/profile.template.md to profile.md and fill it in."
  );
}

function workEntries(md: string, spans: SectionSpan[], work: SectionSpan): ProfileWorkEntry[] {
  return spans
    .filter(
      (s) =>
        s.level > work.level &&
        s.headingStart > work.headingStart &&
        s.headingStart < work.bodyWithSubsectionsEnd,
    )
    .map((s) => {
      const lines = md.slice(s.bodyStart, s.bodyWithSubsectionsEnd).split("\n");
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      return { heading: s.heading, lines };
    });
}

/**
 * NEVER THROWS FOR A MISSING FILE. `GET /api/profile` must answer 200 on a
 * workspace with no `profile.md`, because it is in the sentinel loop at
 * `__tests__/api.test.ts` whose assertion is 200 for every listed route.
 */
export async function readProfile(root: string): Promise<ProfilePayload> {
  const templateAvailable = await exists(paths.profileTemplate(root));
  const md = await readProfileText(root);

  if (md === null) {
    return {
      revision: null,
      exists: false,
      templateAvailable,
      warnings: [missingProfileWarning(root)],
      sections: absentSections(),
      identity: null,
      preferences: null,
      qaBank: null,
      workHistory: [],
      markdownBodies: {},
      resume: null,
      cityRules: [],
      cityRuleTableRows: 0,
    };
  }

  const profile = parseProfile(md);
  const spans = indexSections(md);
  const spanFor = (id: (typeof PROFILE_SECTION_IDS)[number]) => findSectionIn(spans, id);

  const sections: ProfileSectionInfo[] = PROFILE_SECTION_IDS.map((id) => {
    const span = spanFor(id);
    return span
      ? { id, heading: span.heading, present: true, line: span.line }
      : { id, heading: null, present: false, line: null };
  });

  const identitySpan = spanFor("identity");
  const preferencesSpan = spanFor("searchPreferences");
  const qaSpan = spanFor("qaBank");
  const workSpan = spanFor("workHistory");
  const resumeSpan = spanFor("resume");
  const cityRulesSpan = spanFor("cityRules");

  const overridePath = resumeSpan ? profile.resumePath : null;
  const overrideResolved = overridePath ? resolveOverridePath(root, overridePath) : null;

  return {
    revision: createHash("sha256").update(md).digest("hex"),
    exists: true,
    templateAvailable,
    // VERBATIM. All four possible strings come from profile.ts:214, :231, :265
    // and :285; nothing is added, reworded or filtered, or the banner stops
    // matching what /status prints.
    warnings: profile.warnings,
    sections,
    identity: identitySpan
      ? { bullets: readBullets(md, identitySpan), parsed: { ...profile.identity } }
      : null,
    preferences: preferencesSpan
      ? {
          bullets: readBullets(md, preferencesSpan),
          topics: profile.topics,
          titleBlocklist: profile.titleBlocklist,
        }
      : null,
    // The EXACT slice the writer splices back, so the round-trip is idempotent
    // by construction. bodyWithSubsections, not body, so the two `###`
    // subsections travel with it (Q2).
    qaBank: qaSpan ? md.slice(qaSpan.bodyStart, qaSpan.bodyWithSubsectionsEnd) : null,
    // From the raw text, NOT from `profile.candidateSummary`, which is a
    // synthesised digest rather than the section.
    workHistory: workSpan ? workEntries(md, spans, workSpan) : [],
    markdownBodies: Object.fromEntries(
      (["resumeRegionRules", "cityRules", "cityNormalization", "addressPolicy", "workHistory", "education", "authorization", "candidateSummary"] as const).flatMap((id): Array<[typeof id, string]> => {
        const span = spanFor(id);
        if (!span) return [];
        if (id === "candidateSummary") {
          const raw = md.slice(span.bodyStart, span.bodyWithSubsectionsEnd);
          return [[id, readCandidateSummaryEditorBody(raw)]];
        }
        return [[id, md.slice(span.bodyStart, span.bodyWithSubsectionsEnd)]];
      }),
    ),
    resume: resumeSpan
      ? {
          overridePath,
          overrideResolved,
          overrideExists: overrideResolved === null ? null : await exists(overrideResolved),
          regionRules: profile.resumeRegionRules.map((r) => ({ key: r.key, terms: r.terms })),
        }
      : null,
    // `terms` is DROPPED on purpose — see ProfileCityRuleView's doc comment.
    cityRules: profile.cityRules.map(
      (r): ProfileCityRuleView => ({ key: r.key, city: r.city, state: r.state, zips: r.zips }),
    ),
    cityRuleTableRows: cityRulesSpan ? countTableRows(md, cityRulesSpan) : 0,
  };
}
