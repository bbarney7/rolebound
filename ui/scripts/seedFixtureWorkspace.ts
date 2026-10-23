import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Seeds the throwaway practice workspace the manual walkthrough runs
 * against (plan D28). It exists because defaultWorkspaceRoot() otherwise
 * resolves to the LIVE workspace (workspace.ts:18-22): this feature's DELETE
 * is an irreversible fs.unlink and the live gather_state.json is a 322 KB
 * agent-owned file that has already been corrupted once.
 *
 * Output contract with package.json: the resolved root is the ONLY thing
 * written to stdout; every human-readable line goes to stderr. That is what
 * lets dev:fixture do PI_JOBS_ROOT="$(npm run --silent seed:fixture)" while
 * the path itself stays defined in exactly one place — FIXTURE_DIR_NAME.
 */

/** The single definition of the fixture path. package.json never names it. */
const FIXTURE_DIR_NAME = "pi-jobs-ui-fixture";

/**
 * A real plaintext password in the fixture, so the walkthrough's "no
 * response contains a password" curl checks have something to fail on.
 * Against a workspace with no credentials.json those checks pass vacuously.
 * A different literal from __tests__/helpers.ts:5 on purpose, so scripts/
 * does not import from __tests__/.
 */
const FIXTURE_PASSWORD = "FIXTURE-SECRET-do-not-leak";

/**
 * `templates/profile.template.md`, BYTE-IDENTICAL to the repo copy (177 lines).
 *
 * Seeded so the fixture's "Create profile.md from the template" and "Add this
 * section" affordances are live rather than permanently disabled. Inlined for
 * the same reason FIXTURE_PASSWORD is a different literal from the test
 * helper's: `scripts/` and `__tests__/` do not import each other, and this
 * script must not read the repo it is seeding a fixture for.
 */
const FIXTURE_PROFILE_TEMPLATE = `# Applicant Profile

This file is the source of truth for application form fills. The agent reads it at
the start of every application, and the extensions parse the tables and bullets
below for resume, address, and job-filtering rules. Copy it to \`profile.md\` in the
workspace root and replace every \`<FILL IN>\`.

\`profile.md\` is gitignored — it never leaves your machine.

## Identity

- **Full name:** <FILL IN>
- **Preferred name / first name on forms:** <FILL IN>
- **Email:** <FILL IN>
- **Fallback email:** *(optional — used only when an ATS signup form rejects \`+aliasing\`)*
- **Phone:** <FILL IN>
- **LinkedIn:** <FILL IN>
- **GitHub:** *(none — skip if optional; if required, leave blank or "N/A")*
- **Portfolio / website:** *(none — skip if optional; if required, leave blank or "N/A")*
- **Pronouns:** <FILL IN>

## Resume

By default the agent picks \`resumes/<resume_key>.pdf\` for the matched region and
falls back to \`resumes/default.pdf\`. Put at least \`resumes/default.pdf\` in place.

If you use one resume for every application, uncomment the bullet below and point
it at that file — a workspace-relative path (\`resumes/default.pdf\`) or an absolute
one. When this bullet is present it overrides the per-region lookup entirely.

<!-- - **Resume path:** \`resumes/default.pdf\` -->

### Resume region rules (\`resume_key\`)

Which resume file a job location maps to. Delete rows you do not have a resume
for — an unmatched location falls back to \`default\`.

| \`resume_key\` | Match terms |
|---|---|
| \`denver\` | denver, boulder, colorado, co |
| \`chicago\` | chicago, evanston, illinois, il |

## City → Address rules (\`address_city_key\`)

Distinct from \`resume_key\`. The address map (\`state.json.addresses\`) is keyed by
these specific cities so two jobs in the same metro but different cities don't
collapse onto one address.

\`Match terms\` is optional — the display city always matches. The longest matching
term wins, so a metro-wide term ("front range") on one row beats a bare city name
on another.

| \`address_city_key\` | Display "City, State" | Match terms | Real-ZIP candidates |
|---|---|---|---|
| \`denver\` | Denver, CO | denver, front range | one of {80202, 80203, 80206} |
| \`chicago\` | Chicago, IL | chicago, chicagoland | one of {60601, 60614, 60622} |
| \`default\` | Remote — agent stops if a real address is required for a Remote-only role | remote, anywhere | n/a |

### City normalization rules

- Lowercase, strip punctuation, hyphenate spaces (\`San Francisco\` → \`san-francisco\`).
- \`Remote\` / \`Anywhere\` (with or without modifiers) → \`default\`, regardless of other text.
- If a posting names multiple cities, pick the most specific one explicitly listed.
- If a posting's city matches no row above and \`default\` (Remote) is inappropriate
  (e.g. the role demands a local address), **stop and ask**.

## Work history

### <Job title> · <Company> · <YYYY-MM> – Present

<One-paragraph summary of the role.>

- **<Project or theme>** — <what you did and what it produced>.
- **<Project or theme>** — <what you did and what it produced>.

### <Previous job title> · <Company> · <YYYY-MM> – <YYYY-MM>

- <Accomplishment.>
- <Accomplishment.>

## Education

**<Degree>** · <Institution>
- <Honors, GPA, or other detail — delete if not applicable>

## Authorization

- **Citizenship / work authorization:** <FILL IN>
- **Visa sponsorship required:** <FILL IN>
- **Security clearance:** <FILL IN>

## Q&A bank

The agent fills these verbatim. If a posting asks something not covered here, the
agent **stops and asks** rather than fabricating.

- **Desired salary range:** **Conditional rule** — only enter if the application *requires* a salary value:
  - If the posting lists a salary range → enter the **upper end of the listed range**.
  - If the posting does NOT list a range → enter **<FILL IN>**.
  - If the field is optional, skip it.
- **Notice period / earliest start date:** <FILL IN>
- **Why this company (template):** *Plain voice — do not over-polish.*

  > <Two or three sentences about what you want to work on and why this kind of company.
  > Use \`[COMPANY]\` where the company name goes.>

  Substitute \`[COMPANY]\` with the company name. Adjust a phrase or two per posting;
  don't pad it.
- **Willingness to relocate:** <FILL IN>
- **Willingness to travel %:** <FILL IN>
- **Remote / hybrid / onsite preference:** <FILL IN>
- **Years of experience (overall):** <FILL IN>
- **Years of experience per stack:** <FILL IN>
- **Referral source default:** <FILL IN>
- **How did you hear about this role?** <FILL IN>

### EEO / self-identification defaults

These are pre-decided. The agent fills them silently — they are **NOT** stop-and-ask
triggers. Replace any value to override.

- **Gender:** Prefer not to answer
- **Race / ethnicity:** Prefer not to answer
- **Veteran status:** Prefer not to answer
- **Disability status:** Prefer not to answer
- **Hispanic / Latino origin:** Prefer not to answer

### Open-ended question defaults

For free-text questions where a generic answer is acceptable, the agent uses these.
For anything needing a company- or role-tailored answer, the agent **stops and asks**.

- **"Tell us about yourself" / cover letter (short):** <FILL IN — a paragraph you'd be happy to submit unedited>
- **Greatest strength:** *Not asked in standard applications — if a posting actually asks, **stop and ask the user**.*
- **Why are you leaving your current role?:** *Not asked in standard applications — if a posting actually asks, **stop and ask the user**.*

## Job search preferences

Read by the gatherer. Both bullets are optional — omit either one and the
extension's built-in defaults apply. Role detection (director / engineering
manager / staff IC, with non-engineering "manager" titles excluded) is generic
and always lives in the extension.

- **Target topics:** ai, agentic, agent, ml, machine learning, llm, platform, inference
- **Title blocklist:** intern, new grad, early career, vp, chief, sales, customer success

## Candidate summary

<!--
Everything below this comment, verbatim, is what the gatherer sends to the scoring
model with each discovered job. Keep it short — it is prepended to every scoring
request. Delete this whole section and the gatherer composes a summary from
\`## Identity\` and \`## Work history\` instead.
-->

Candidate: <FILL IN name>
Current: <FILL IN current title and company>
Previous: <FILL IN prior roles>
Experience: <FILL IN> years total

Key accomplishments:
- <FILL IN>
- <FILL IN>

Technical: <FILL IN stack>

Target roles: <FILL IN>
Target level: <FILL IN>
Target locations: <FILL IN>
Education: <FILL IN>

## Address policy reminder

> Use the address persisted in \`state.json.addresses[<address_city_key>]\` for the
> matched city. If it is missing, call \`generate_address\` — it uses only the ZIP
> candidates declared above and persists the result before the form is filled. If
> \`generate_address\` declines (no such city, or no ZIPs listed), **stop and ask**.
`;

/**
 * THE SCREENSHOT FIXTURE'S profile.md IS DELIBERATELY *NOT* THE TEST FIXTURE'S.
 *
 * `server/__tests__/helpers.ts` seeds the template VERBATIM, because that is the
 * only thing that exercises the warnings inversion — the template yields exactly
 * one parser warning and a real profile yields none.
 *
 * This one is drifted like the live workspace's, because on real data the empty
 * and orphan states ARE the normal rendering path and a pristine template shows
 * none of them. Measured against the parser and the locator in-session:
 *
 *   - NO `### Resume region rules`, NO `## Job search preferences`, NO
 *     `## Candidate summary` — three absent sections, nine present.
 *   - Identity filled in, so `warnings` is EMPTY and the healthy state is what
 *     the screenshot shows. `Fallback email` is an italic-only aside, so it
 *     round-trips into the form and reads as null to the agent — the one control
 *     that makes "what the parser discards" visible.
 *   - A THREE-column city table (the live one's shape), four data rows, two of
 *     them unusable: `default` is skipped by design and `portland` has a
 *     placeholder city. cityRuleTableRows 4 vs cityRules 2.
 *   - The `## Resume` path bullet stays inside its HTML comment, so there is no
 *     override and every resume but `default.pdf` is an orphan.
 *
 * Do not "fix" either fixture into the other. Two fixtures, two jobs.
 */
const FIXTURE_PROFILE_DRIFTED = `# Applicant Profile

This file is the source of truth for application form fills. The agent reads it at
the start of every application, and the extensions parse the tables and bullets
below for resume, address, and job-filtering rules.

## Identity

- **Full name:** Robin Fixture
- **Preferred name:** Robin
- **Email:** robin.fixture@example.com
- **Fallback email:** *(none — the address above is the only one)*
- **Phone:** +1 555 0100
- **LinkedIn:** https://www.linkedin.com/in/robin-fixture
- **GitHub:** *(none — skip if optional, answer "N/A" if required)*
- **Portfolio / website:** *(none — skip if optional)*
- **Current location:** Seattle, WA

## Resume

By default the agent picks \`resumes/<resume_key>.pdf\` for the matched region and
falls back to \`resumes/default.pdf\`.

To pin ONE file for every application regardless of region, uncomment the bullet
below and point it at that file.

<!-- - **Resume path:** \`resumes/default.pdf\` -->

## City → Address rules (\`address_city_key\`)

| \`address_city_key\` | City, State | ZIPs to choose from |
| --- | --- | --- |
| \`default\` | Remote — no street address | handled in code |
| \`seattle\` | Seattle, WA | one of {98101, 98103, 98109} |
| \`denver\` | Denver, CO | one of {80202, 80211} |
| \`portland\` | *(fill in when a Portland role comes up)* | one of {97209, 97214} |

### City normalization rules

- "Greater Seattle Area", "Bellevue", "Redmond" and "Kirkland" all normalize to \`seattle\`.
- Anything explicitly Remote, Anywhere or Distributed uses \`default\`.
- A metro area named after a city uses that city's row.

## Work history

### Staff Engineer · Meridian Systems · 2022-04 – Present

- Owns the ingest pipeline that moves 40M events a day.
- Led the migration off the hand-rolled scheduler onto a queue the on-call team can reason about.

### Senior Engineer · Northwind Data · 2019-01 – 2022-03

- Built the reporting API three product teams depend on.
- Cut p99 query latency from 4s to 380ms without a schema change.

### Engineer · Coastline Labs · 2016-06 – 2018-12

- First engineering hire; shipped the original product with two other people.

## Education

- **Degree:** B.S. Computer Science
- **Institution:** University of Washington
- **Graduated:** 2016

## Authorization

- **Work authorization:** Authorized to work in the US for any employer
- **Sponsorship required:** No
- **Security clearance:** None

## Q&A bank

- **Desired salary:** Answer "Open, based on the full package" unless a number is required.
  - If a single number is required, answer 210000.
  - If a range is required, answer 190000–230000.
- **Notice period:** Two weeks.
- **Willing to relocate:** No — remote, or on-site within the Seattle metro.
- **How did you hear about us?** Company website.

> Cover letter default, used only when one is required and nothing better fits:
> I have spent the last eight years building data infrastructure other teams rely
> on, and [COMPANY]'s work on that problem is why I am applying.

*Stop and ask before answering anything about compensation history.*

### EEO / self-identification defaults

- **Gender:** Decline to self-identify
- **Race / ethnicity:** Decline to self-identify
- **Veteran status:** I am not a protected veteran
- **Disability status:** I do not wish to answer

### Open-ended question defaults

- **Why this company?** One sentence from the posting, one from Work history.
- **Greatest strength?** Turning an undocumented system into one other teams can use.

## Address policy reminder

\`generate_address\` may use ONLY the ZIPs the matching rule row declares. It must
never invent a ZIP, and it must never reuse an address generated for a different
\`address_city_key\`.
`;

/**
 * Emits the gatherer's exact byte shape (job-gatherer.ts:894-915): "---",
 * one `key: value` line per field in its fixed order, "---", then the body
 * with NO blank line between them — the gatherer's
 * `.filter((l) => l !== "")` at :914 strips its own separators — and
 * exactly one trailing newline.
 */
function jobFile(frontmatter: string[], body: string[]): string {
  return `${["---", ...frontmatter, "---", ...body].join("\n")}\n`;
}

/**
 * realpath, because macOS os.tmpdir() is /var -> /private/var and
 * proper-lockfile canonicalizes its target before locking; an unresolved
 * path makes withLock() on <root>/gather_state.json fail. Same reason
 * __tests__/helpers.ts:12-15 does it.
 */
async function resolveFixtureRoot(): Promise<string> {
  const tmp = await fs.realpath(os.tmpdir());
  return path.join(tmp, FIXTURE_DIR_NAME);
}

/**
 * Delete and recreate the fixture root. This is a recursive rm on a path
 * assembled from os.tmpdir(), so it is guarded: refuse anything whose
 * parent is not the resolved temp dir or whose basename is not
 * FIXTURE_DIR_NAME. A future edit to resolveFixtureRoot() therefore cannot
 * turn this into a recursive delete of a real directory.
 */
async function resetRoot(root: string): Promise<void> {
  const tmp = await fs.realpath(os.tmpdir());
  if (path.dirname(root) !== tmp || path.basename(root) !== FIXTURE_DIR_NAME) {
    throw new Error(`refusing to delete ${root}: not <tmpdir>/${FIXTURE_DIR_NAME}`);
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
  await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
  // The UI's own state file lives under <root>/ui/ (server/workspace.ts) and
  // the server never creates the directory, so the seeder must.
  await fs.mkdir(path.join(root, "ui"), { recursive: true });
  // Same reason for these two: `paths.profileTemplate` and `paths.resumesDir`
  // (server/workspace.ts) are read, never created, and a missing templates/
  // would disable the fixture's create and add-section affordances outright.
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.mkdir(path.join(root, "resumes"), { recursive: true });
}

async function writeJob(
  root: string,
  dir: "queue" | "applied" | "discovered",
  filename: string,
  text: string,
): Promise<void> {
  await fs.writeFile(path.join(root, "jobs", dir, filename), text);
}

async function seed(root: string): Promise<void> {
  // ── jobs/queue ──────────────────────────────────────────────────────
  // The `0-` prefix is the applier's hand-written "run this next"
  // convention (state.json references jobs/queue/0-hackerone-…-austin.md).
  // D29: the UI displays it and never writes it. Under the D17 filename
  // comparator "0" (0x30) sorts before every letter, so this row is
  // position 0 — which is exactly what /apply-next consumes (mdFiles[0]).
  await writeJob(
    root,
    "queue",
    "0-priority-fixture-role.md",
    jobFile(
      [
        "url: https://jobs.example.com/priority/role-1",
        "company: Priority Fixture Co",
        "title: Director, Platform",
        "location: Remote",
        "source: greenhouse",
        "match: strong",
        "discovered_at: 2026-08-01T10:00:00.000Z",
      ],
      [
        "ATS: greenhouse",
        'Role match: "director" + topic "platform"',
        "Location key: default (remote)",
        "Req ID: PF-1",
        "Description excerpt:",
        "Seeded fixture posting. Numeric prefix marks it as run-next.",
      ],
    ),
  );

  // ── The prefix pair. THIS IS THE POINT OF THE FIXTURE (risk R1). ─────
  // "acme-engineer" is a strict prefix of "acme-engineer-finops" followed
  // by "-". Sorting slugs puts acme-engineer first; sorting FILENAMES puts
  // acme-engineer-finops.md first, because "-" is 0x2D and "." is 0x2E.
  // The applier sorts filenames (job-applier.ts:669, :897). With D17 the UI
  // must render acme-engineer-finops ABOVE acme-engineer; without D17 it
  // renders them the other way round. No live queue file can show this.
  await writeJob(
    root,
    "queue",
    "acme-engineer.md",
    jobFile(
      [
        "url: https://jobs.example.com/acme/eng-1",
        "company: Acme",
        "title: Engineer",
        "location: Seattle, WA",
        "source: greenhouse",
        "match: strong",
        "discovered_at: 2026-08-01T11:00:00.000Z",
        "resume_key: seattle",
        "address_city_key: seattle",
      ],
      [
        "ATS: greenhouse",
        'Role match: "engineer"',
        "Location key: seattle",
        "Req ID: ACME-1",
        "Description excerpt:",
        "Seeded fixture posting carrying both advisory override keys.",
      ],
    ),
  );
  await writeJob(
    root,
    "queue",
    "acme-engineer-finops.md",
    jobFile(
      [
        "url: https://jobs.example.com/acme/eng-finops",
        "company: Acme",
        "title: Engineer, FinOps",
        "location: Seattle, WA",
        "source: greenhouse",
        "match: strong",
        "discovered_at: 2026-08-01T11:05:00.000Z",
      ],
      [
        "ATS: greenhouse",
        'Role match: "engineer" + topic "finops"',
        "Location key: seattle",
        "Req ID: ACME-2",
        "Description excerpt:",
        "Second half of the prefix pair that proves the D17 ordering fix.",
      ],
    ),
  );

  // Reproduces the live invalid-YAML shape byte for byte:
  // jobs/queue/render-engineering-manager-platform.md:4-5 has a trailing
  // space in `title:` and an unquoted second colon in `location:`.
  // gray-matter throws on it, so this row can only render through
  // parseFrontmatterTolerant (jobFiles.ts).
  await writeJob(
    root,
    "queue",
    "render-invalid-yaml-location.md",
    jobFile(
      [
        "url: https://jobs.example.com/render/em-platform",
        "company: Render Fixture",
        "title: Engineering Manager, Platform ",
        "location: Remote: United States",
        "source: ashby",
        "match: strong",
        "discovered_at: 2026-08-01T12:00:00.000Z",
      ],
      [
        "ATS: ashby",
        'Role match: "engineering manager" + topic "platform"',
        "Location key: default (remote)",
        "Req ID: RF-1",
        "Description excerpt:",
        "Invalid strict YAML on purpose. Must still render.",
      ],
    ),
  );

  await writeJob(
    root,
    "queue",
    "zeta-platform-em.md",
    jobFile(
      [
        "url: https://jobs.example.com/zeta/platform-em",
        "company: Zeta",
        "title: Platform Engineering Manager",
        "location: Remote",
        "source: greenhouse",
        "match: weak",
        "discovered_at: 2026-08-01T13:00:00.000Z",
      ],
      [
        "ATS: greenhouse",
        'Role match: "engineering manager" + topic "platform"',
        "Location key: default (remote)",
        "Req ID: ZETA-1",
        "Description excerpt:",
        "Last row under the filename comparator.",
      ],
    ),
  );

  // ── jobs/discovered ─────────────────────────────────────────────────
  // acme-engineer-finops.md exists in BOTH queue and discovered, so the
  // walkthrough can exercise the promote-collision path: the link fails
  // EEXIST and the route answers 409 instead of clobbering (D25).
  await writeJob(
    root,
    "discovered",
    "acme-engineer-finops.md",
    jobFile(
      [
        "url: https://jobs.example.com/acme/eng-finops",
        "company: Acme",
        "title: Engineer, FinOps",
        "location: Seattle, WA",
        "source: greenhouse",
        "match: strong",
        "discovered_at: 2026-08-01T11:05:00.000Z",
        "llm_score: 3",
      ],
      [
        "ATS: greenhouse",
        'Role match: "engineer" + topic "finops"',
        "Location key: seattle",
        "Req ID: ACME-2",
        "Description excerpt:",
        "Deliberate slug collision with jobs/queue/acme-engineer-finops.md.",
      ],
    ),
  );
  await writeJob(
    root,
    "discovered",
    "initech-engineering-manager.md",
    jobFile(
      [
        "url: https://jobs.example.com/initech/em-1",
        "company: Initech",
        "title: Engineering Manager, Payments",
        "location: Austin, TX",
        "source: lever",
        "match: strong",
        "discovered_at: 2026-08-02T09:00:00.000Z",
        "llm_score: 5",
      ],
      [
        "ATS: lever",
        'Role match: "engineering manager"',
        "Location key: austin",
        "Req ID: INI-1",
        "Description excerpt:",
        "Highest llm_score in the fixture — sorts first in the picker.",
      ],
    ),
  );
  await writeJob(
    root,
    "discovered",
    "globex-staff-engineer.md",
    jobFile(
      [
        "url: https://jobs.example.com/globex/staff-1",
        "company: Globex",
        "title: Staff Engineer, Infrastructure",
        "location: Remote",
        "source: ashby",
        "match: strong",
        "discovered_at: 2026-08-02T10:00:00.000Z",
        "llm_score: 4",
      ],
      [
        "ATS: ashby",
        'Role match: "staff engineer" + topic "infrastructure"',
        "Location key: default (remote)",
        "Req ID: GLO-1",
        "Description excerpt:",
        "Second by score.",
      ],
    ),
  );
  await writeJob(
    root,
    "discovered",
    "soylent-principal-engineer.md",
    jobFile(
      [
        "url: https://jobs.example.com/soylent/principal-1",
        "company: Soylent",
        "title: Principal Engineer",
        "location: New York, NY",
        "source: greenhouse",
        "match: weak",
        "discovered_at: 2026-08-02T11:00:00.000Z",
        "llm_score: 3",
      ],
      [
        "ATS: greenhouse",
        'Role match: "principal engineer"',
        "Location key: nyc",
        "Req ID: SOY-1",
        "Description excerpt:",
        "Ties on score with acme-engineer-finops; slug breaks the tie.",
      ],
    ),
  );
  await writeJob(
    root,
    "discovered",
    "umbrella-director-platform.md",
    jobFile(
      [
        "url: https://jobs.example.com/umbrella/director-1",
        "company: Umbrella",
        "title: Director, Platform Engineering",
        "location: Remote",
        "source: workday",
        "match: weak",
        "discovered_at: 2026-08-02T12:00:00.000Z",
        "llm_score: 2",
      ],
      [
        "ATS: workday",
        'Role match: "director" + topic "platform"',
        "Location key: default (remote)",
        "Req ID: UMB-1",
        "Description excerpt:",
        "Lowest score — sorts last in the picker.",
      ],
    ),
  );

  // ── jobs/applied ────────────────────────────────────────────────────
  // One applied file so /api/overview and the history view are not empty
  // while the walkthrough moves between the two views.
  await writeJob(
    root,
    "applied",
    "omega-head-of-platform.md",
    jobFile(
      [
        "url: https://jobs.example.com/omega/head-platform",
        "company: Omega",
        "title: Head of Platform",
        "location: Remote",
        "source: greenhouse",
        "applied_at: 2026-07-20T18:00:00.000Z",
      ],
      [
        "ATS: greenhouse",
        "Req ID: OMG-1",
        "Description excerpt:",
        "Seeded applied posting.",
      ],
    ),
  );

  // A second submitted row, so both pipeline overlays below (interviewing on
  // omega, offer on sigma) have a real row to attach to — applyUiOverlay only
  // decorates applications that already exist in the union.
  await writeJob(
    root,
    "applied",
    "sigma-staff-engineer-agents.md",
    jobFile(
      [
        "url: https://jobs.example.com/sigma/staff-agents",
        "company: Sigma",
        "title: Staff Engineer, Agents",
        "location: Seattle, WA",
        "source: ashby",
        "applied_at: 2026-07-28T16:00:00.000Z",
      ],
      ["ATS: ashby", "Req ID: SIG-7", "Description excerpt:", "Seeded applied posting (second submitted row)."],
    ),
  );

  // ── gather_state.json ───────────────────────────────────────────────
  // Small but structurally complete: all four top-level keys the live file
  // has, and three seen_urls decisions including "discovered-manual",
  // which appears 8 times live and in NO source file (job-gatherer.ts:353
  // declares only discovered|rejected|promoted). The writer must merge
  // over it without switching on it (D24). 2-space indent and NO trailing
  // newline, matching job-gatherer.ts's own serialization (D25).
  const gatherState = {
    seen_urls: {
      "https://jobs.example.com/globex/staff-1": {
        first_seen: "2026-08-02T10:00:00.000Z",
        source: "ashby",
        company: "Globex",
        title: "Staff Engineer, Infrastructure",
        decision: "discovered",
      },
      "https://jobs.example.com/umbrella/director-1": {
        first_seen: "2026-08-02T12:00:00.000Z",
        source: "workday",
        company: "Umbrella",
        title: "Director, Platform Engineering",
        decision: "discovered-manual",
      },
      "https://jobs.example.com/rejected/role-9": {
        first_seen: "2026-07-30T08:00:00.000Z",
        source: "greenhouse",
        company: "Rejected Fixture Co",
        title: "Sales Engineer",
        decision: "rejected",
        reject_reason: "role filter",
      },
    },
    per_company: {
      globex: { last_fetched: "2026-08-02T10:00:00.000Z", openings_count: 12, matched_count: 1 },
      initech: { last_fetched: "2026-08-02T09:00:00.000Z", openings_count: 4, matched_count: 1 },
    },
    last_full_gather: "2026-08-02T12:30:00.000Z",
    auto_promote: false,
  };
  await fs.writeFile(
    path.join(root, "gather_state.json"),
    JSON.stringify(gatherState, null, 2),
  );

  // ── credentials.json ────────────────────────────────────────────────
  // Six entries, because one featureless row exercises none of the accounts
  // view. Between them they cover every branch the list and the detail can
  // take:
  //   - all four login Stamp tones: "success", "failed", "pending", and the
  //     field ABSENT (the neutral "not set" case);
  //   - one entry with NO password key at all, so hasPassword: false renders;
  //   - varied last_used_at including one ABSENT, which the sort puts last;
  //   - one long notes value, so the detail's notes block holds real text;
  //   - "jobs.example.com" is the hostname of every seeded application URL
  //     (jobs/applied above and state.json below), so findAccount
  //     (routes/applications.ts:50-66) resolves those rows to THIS account by
  //     its exact-hostname branch and its detail lists them instead of the
  //     empty state.
  await fs.writeFile(
    path.join(root, "credentials.json"),
    JSON.stringify(
      {
        "jobs.example.com": {
          username: "fixture-user@example.com",
          password: FIXTURE_PASSWORD,
          email_used: "fixture-user@example.com",
          ats: "greenhouse",
          company: "Example Job Board",
          created_at: "2026-05-14T09:00:00Z",
          last_used_at: "2026-08-04T09:15:00Z",
          last_login_status: "success",
          notes:
            "Shared job-board login behind every seeded application. MFA is " +
            "enforced on this host, so the applier pauses for a one-time code " +
            "before it can submit and the run looks stalled until the code is " +
            "entered. Password rotates every 90 days; last rotated " +
            "2026-07-12, next due 2026-10-10.",
        },
        "careers.globex.example.com": {
          username: "fixture-globex",
          password: FIXTURE_PASSWORD,
          email_used: "fixture-user@example.com",
          ats: "lever",
          company: "Globex",
          created_at: "2026-06-02T15:30:00Z",
          last_used_at: "2026-08-01T11:30:00Z",
          last_login_status: "failed",
          notes: "Last sign-in bounced off the SSO redirect; re-check the username.",
        },
        "initech.wd3.myworkdayjobs.com": {
          username: "fixture-user@example.com",
          password: FIXTURE_PASSWORD,
          email_used: "fixture-user@example.com",
          ats: "workday",
          company: "Initech",
          created_at: "2026-06-18T08:00:00Z",
          last_used_at: "2026-07-26T14:05:00Z",
          last_login_status: "pending",
        },
        "fixture.wd5.myworkdayjobs.com": {
          username: "fixture-user@example.com",
          password: FIXTURE_PASSWORD,
          email_used: "fixture-user@example.com",
          ats: "workday",
          company: "Fixture Co",
          created_at: "2026-07-01T00:00:00Z",
          last_used_at: "2026-07-20T18:00:00Z",
        },
        "apply.soylent.example.net": {
          username: "fixture-user@example.com",
          email_used: "fixture-user@example.com",
          ats: "ashby",
          company: "Soylent",
          created_at: "2026-06-25T19:45:00Z",
          last_used_at: "2026-07-05T13:20:00Z",
          last_login_status: "success",
          notes: "Single sign-on only — nothing to store, so no password is on file.",
        },
        "talent.umbrella.example.org": {
          username: "fixture-umbrella",
          password: FIXTURE_PASSWORD,
          email_used: "fixture-user@example.com",
          ats: "smartrecruiters",
          company: "Umbrella",
          created_at: "2026-08-05T16:40:00Z",
          last_login_status: "pending",
          notes: "Registered for an upcoming posting; never signed in yet.",
        },
      },
      null,
      2,
    ),
  );

  // ── settings.json ───────────────────────────────────────────────────
  // A provider WITH a key, so the Settings view's "key set" state, the
  // last-four hint, the Remove control, and the overview's solver stage all
  // render on the fixture. FIXTURE_PASSWORD doubles as the key so the
  // walkthrough's "no response contains a secret" curl checks cover it.
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ captcha: { provider: "2captcha", api_key: FIXTURE_PASSWORD } }, null, 2),
  );

  // ── templates/, profile.md, resumes/ ────────────────────────────────
  await fs.writeFile(
    path.join(root, "templates", "profile.template.md"),
    FIXTURE_PROFILE_TEMPLATE,
  );
  await fs.writeFile(path.join(root, "profile.md"), FIXTURE_PROFILE_DRIFTED);

  // Six files, five of them orphaned, and the arithmetic is the point.
  //
  // The drifted profile has NO `### Resume region rules` table and no active
  // resume-path override, so `resolveResumePath` (job-applier.ts:79-89) can
  // reach exactly one of these: `default.pdf`. `seattle.pdf` and `denver.pdf`
  // look reachable — the city table names both regions — and are not, because
  // resume keys come from the region-rules table alone. `resume-draft.docx` is
  // an orphan on the extension rule, which outranks everything else.
  //
  // `.pdf` is in WATCH_IGNORED (server/routes/events.ts:18), so none of these
  // perturbs the SSE stream the walkthrough is watching.
  for (const name of [
    "default.pdf",
    "seattle.pdf",
    "denver.pdf",
    "austin.pdf",
    "2023-archive.pdf",
    "resume-draft.docx",
  ]) {
    await fs.writeFile(path.join(root, "resumes", name), `stub ${name}\n`);
  }

  // ── state.json ──────────────────────────────────────────────────────
  await fs.writeFile(
    path.join(root, "state.json"),
    JSON.stringify(
      {
        applications: [
          {
            slug: "omega-head-of-platform",
            status: "submitted",
            url: "https://jobs.example.com/omega/head-platform",
            company: "Omega",
            title: "Head of Platform",
            location_raw: "Remote",
            attempts: [
              {
                started_at: "2026-07-20T17:50:00Z",
                ended_at: "2026-07-20T18:00:00Z",
                outcome: "submitted",
                notes: "Seeded fixture attempt.",
              },
            ],
            submitted_at: "2026-07-20T18:00:00Z",
            queue_file: "jobs/applied/omega-head-of-platform.md",
          },
          // One application per ApplyState below, so every status stamp,
          // the apply-state bar and the no-attempts detail case are all
          // visible on the fixture (ui-design-overhaul task 4).
          {
            slug: "sigma-staff-engineer-agents",
            status: "submitted",
            url: "https://jobs.example.com/sigma/staff-agents",
            company: "Sigma",
            title: "Staff Engineer, Agents",
            location_raw: "Seattle, WA",
            resume_key: "seattle",
            address_city_key: "seattle",
            resume: "resumes/seattle.pdf",
            address: { street: "1424 Oak St", city: "Seattle", state: "WA", zip: "98103" },
            attempted_at: "2026-07-28T15:40:00Z",
            attempts: [
              {
                started_at: "2026-07-28T15:40:00Z",
                ended_at: "2026-07-28T16:00:00Z",
                outcome: "submitted",
                notes: "Seeded fixture attempt (second submitted row).",
              },
            ],
            submitted_at: "2026-07-28T16:00:00Z",
            queue_file: "jobs/applied/sigma-staff-engineer-agents.md",
          },
          {
            slug: "vega-engineering-manager-ml",
            status: "queued",
            url: "https://jobs.example.com/vega/em-ml",
            company: "Vega",
            title: "Engineering Manager, ML",
            location_raw: "Remote",
            resume_key: "default",
            address_city_key: "default",
            attempted_at: "2026-08-01T09:00:00Z",
            attempts: [],
            submitted_at: null,
            queue_file: "jobs/queue/vega-engineering-manager-ml.md",
          },
          {
            slug: "kappa-director-platform",
            status: "in_progress",
            url: "https://jobs.example.com/kappa/director-platform",
            company: "Kappa",
            title: "Director, Platform Engineering",
            location_raw: "Seattle, WA",
            resume_key: "seattle",
            address_city_key: "seattle",
            attempted_at: "2026-08-02T14:00:00Z",
            attempts: [{ started_at: "2026-08-02T14:00:00Z", ended_at: null, outcome: null, notes: "" }],
            submitted_at: null,
            queue_file: "jobs/queue/kappa-director-platform.md",
          },
          {
            slug: "lambda-senior-manager-infra",
            status: "paused_for_user",
            url: "https://jobs.example.com/lambda/senior-manager-infra",
            company: "Lambda",
            title: "Senior Engineering Manager, Infrastructure",
            location_raw: "Remote",
            resume_key: "default",
            address_city_key: "default",
            attempted_at: "2026-08-02T15:00:00Z",
            attempts: [],
            submitted_at: null,
            queue_file: "jobs/queue/lambda-senior-manager-infra.md",
          },
          {
            slug: "theta-head-of-ml",
            status: "aborted",
            url: "https://jobs.example.com/theta/head-ml",
            company: "Theta",
            title: "Head of Machine Learning",
            location_raw: "Remote",
            resume_key: "default",
            address_city_key: "default",
            attempted_at: "2026-08-02T16:00:00Z",
            attempts: [
              {
                started_at: "2026-08-02T16:00:00Z",
                ended_at: "2026-08-02T16:04:00Z",
                outcome: "aborted",
                notes: "SSO wall — no Google session in the persistent profile.",
              },
            ],
            submitted_at: null,
            abort_reason: "SSO wall",
            queue_file: "jobs/queue/theta-head-of-ml.md",
          },
          {
            slug: "iota-staff-platform",
            status: "blocked",
            url: "https://jobs.example.com/iota/staff-platform",
            company: "Iota",
            title: "Staff Engineer, Platform",
            location_raw: "Remote",
            resume_key: "default",
            address_city_key: "default",
            attempted_at: "2026-08-02T17:00:00Z",
            attempts: [
              {
                started_at: "2026-08-02T17:00:00Z",
                ended_at: "2026-08-02T17:02:00Z",
                outcome: "blocked",
                notes: "hCaptcha on step 2.",
              },
            ],
            submitted_at: null,
            block_reason: "CAPTCHA on step 2",
            queue_file: "jobs/queue/iota-staff-platform.md",
          },
          {
            slug: "zeta-eng-manager-data",
            status: "failed",
            url: "https://jobs.example.com/zeta/em-data",
            company: "Zeta",
            title: "Engineering Manager, Data",
            location_raw: "Remote",
            resume_key: "default",
            address_city_key: "default",
            attempted_at: "2026-08-02T18:00:00Z",
            attempts: [
              {
                started_at: "2026-08-02T18:00:00Z",
                ended_at: "2026-08-02T18:01:00Z",
                outcome: "failed",
                notes: "Form POST returned 500 twice.",
              },
            ],
            submitted_at: null,
            queue_file: "jobs/queue/zeta-eng-manager-data.md",
          },
        ],
        // `seattle` is resolved (a rule and an address agree); `denver` has a
        // rule and no address, so it renders as pending. `tampa` and `austin`
        // are ORPHANS — generated addresses whose keys the city table does not
        // define — mirroring the live workspace, where the same two keys sit
        // against a rules table that defines neither. That is the state this
        // fixture exists to make visible.
        addresses: {
          seattle: { street: "1424 Oak St", city: "Seattle", state: "WA", zip: "98103" },
          tampa: { street: "88 Bayshore Blvd", city: "Tampa", state: "FL", zip: "33606" },
          austin: { street: "2201 Rio Grande St", city: "Austin", state: "TX", zip: "78705" },
        },
        acknowledged_at: "2026-07-01T00:00:00Z",
        acknowledged_policy: "auto-submit-v1",
        last_updated: "2026-07-20T18:00:00Z",
      },
      null,
      2,
    ),
  );

  // ── ui/ui-state.json ────────────────────────────────────────────────
  // Two explicit pipeline statuses so the overview funnel's Interviewing and
  // Offers stages are nonzero on the fixture.
  await fs.writeFile(
    path.join(root, "ui", "ui-state.json"),
    JSON.stringify(
      {
        version: 1,
        applications: {
          "omega-head-of-platform": { pipelineStatus: "interviewing", pipelineUpdatedAt: "2026-08-03T12:00:00.000Z" },
          "sigma-staff-engineer-agents": { pipelineStatus: "offer", pipelineUpdatedAt: "2026-08-04T12:00:00.000Z" },
        },
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const root = await resolveFixtureRoot();
  await resetRoot(root);
  await seed(root);
  const queue = (await fs.readdir(path.join(root, "jobs", "queue"))).length;
  const discovered = (await fs.readdir(path.join(root, "jobs", "discovered"))).length;
  const resumes = (await fs.readdir(path.join(root, "resumes"))).length;
  // Counts only, never profile content: this is a diagnostic, not a dump, and
  // the file it describes is the one thing the walkthrough is about to edit.
  process.stderr.write(
    `[seed:fixture] root: ${root}\n` +
      `[seed:fixture] queue files: ${queue}, discovered files: ${discovered}\n` +
      `[seed:fixture] profile.md: drifted (3 sections absent), resumes: ${resumes}\n`,
  );
  // THE OUTPUT CONTRACT: the resolved root is the ONLY thing on stdout, because
  // dev:fixture reads PI_JOBS_ROOT from it.
  process.stdout.write(`${root}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[seed:fixture] failed: ${String(err)}\n`);
  process.exit(1);
});
