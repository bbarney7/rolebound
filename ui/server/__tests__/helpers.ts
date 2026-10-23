import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const SENTINEL_PASSWORD = "SENTINEL-SECRET-do-not-leak";

/**
 * `templates/profile.template.md`, BYTE-IDENTICAL to the repo's copy (177 lines).
 *
 * Inlined rather than read from the repo: `scripts/` and `__tests__/` do not
 * import each other (`seedFixtureWorkspace.ts:25-26` records that rule) and a
 * test must not read the repo it is testing. The only escaping is `\``.
 */
export const FIXTURE_PROFILE_TEMPLATE = `# Applicant Profile

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
 * A profile shaped like the LIVE one, and the drift is the point: no
 * `### Resume region rules`, no `## Job search preferences`, no
 * `## Candidate summary`, a three-column city table, and a filled-in Identity
 * so `parseProfile` emits ZERO warnings. That inversion against the template
 * (exactly one warning) is asserted from both sides in 9.22/9.23.
 *
 * NOT seeded by `makeFixtureWorkspace` — a case that wants it writes it over
 * `profile.md` in its OWN fixture. The shared fixture stays template-seeded.
 */
export const FIXTURE_LIVE_SHAPED_PROFILE = `# Applicant Profile

## Identity

- **Full name:** Jane Doe
- **Preferred name / first name on forms:** Jane
- **Email:** jane@example.com
- **Fallback email:** jane.doe@example.com
- **Phone:** 555-0100
- **LinkedIn:** https://linkedin.com/in/janedoe
- **GitHub:** *(none — skip if optional; if required, leave blank or "N/A")*
- **Portfolio / website:** *(none — skip if optional)*
- **Pronouns:** she/her

## Resume

By default the agent picks \`resumes/<resume_key>.pdf\`.

<!-- - **Resume path:** \`resumes/default.pdf\` -->

## City → Address rules (\`address_city_key\`)

| \`address_city_key\` | Display "City, State" | Real-ZIP candidates |
|---|---|---|
| \`seattle\` | Seattle, WA | one of {98101, 98103} |
| \`denver\` | Denver, CO | one of {80202, 80203} |
| \`default\` | Remote — agent stops if a real address is required | n/a |

### City normalization rules

- Lowercase, strip punctuation.

## Work history

### Staff Engineer · Acme · 2022-01 – Present

Led the platform team.

- **Platform** — built the thing.

### Senior Engineer · Beta · 2019-01 – 2021-12

- Shipped a lot.

## Education

**BS** · State University

## Authorization

- **Citizenship / work authorization:** US citizen

## Q&A bank

The agent fills these verbatim.

- **Desired salary range:** 200000
- **Notice period / earliest start date:** 2 weeks

### EEO / self-identification defaults

- **Gender:** Prefer not to answer

### Open-ended question defaults

- **Greatest strength:** *Not asked in standard applications.*

## Address policy reminder

> Use the address persisted in \`state.json.addresses[<address_city_key>]\`.
`;

/**
 * Build a temporary fixture workspace mirroring the real pi-jobs layout.
 * Never touches the live workspace.
 */
export async function makeFixtureWorkspace(): Promise<string> {
  // realpath: macOS tmpdir is a symlink (/var → /private/var) which breaks
  // proper-lockfile's canonicalization
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, "pi-jobs-ui-test-"));

  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
  await fs.mkdir(path.join(root, "screenshots"), { recursive: true });

  // state.json: one submitted (with address + null-field attempt), one in_progress
  const state = {
    applications: [
      {
        slug: "acme-engineering-manager",
        status: "submitted",
        url: "https://boards.greenhouse.io/acme/jobs/123",
        company: "Acme",
        title: "Engineering Manager",
        location_raw: "Seattle, WA",
        resume: "/abs/jane-doe-resume.pdf",
        resume_key: "default",
        address_city_key: "seattle",
        address: { street: "500 Pike St", city: "Seattle", state: "WA", zip: "98101" },
        attempts: [
          { started_at: "2026-07-22T17:00:00Z", outcome: "in_progress" },
          {
            started_at: "2026-07-22T17:00:00Z",
            ended_at: "2026-07-22T17:05:00Z",
            outcome: "submitted",
            notes: "Greenhouse form. EEO declined.",
          },
        ],
        screenshot: "screenshots/acme-engineering-manager-confirmation.png",
        submitted_at: "2026-07-22T17:05:00Z",
      },
      {
        slug: "inprogress-director",
        status: "in_progress",
        url: "https://example.wd1.myworkdayjobs.com/job/1",
        company: "InProgressCo",
        title: "Director",
        location_raw: "Remote - USA",
        resume: "/abs/jane-doe-resume.pdf",
        attempts: [{ started_at: "2026-07-22T18:00:00Z", outcome: "in_progress" }],
      },
    ],
    // `seattle` and `tampa` are ORPHANS against the template's city rules
    // (`denver`, `chicago`, `default`), which leaves `denver`/`chicago` PENDING.
    // `default` is the regression guard: `parseCityRules:271` skips that row
    // deliberately, so a naive left-join would flag it as an orphan and this
    // one must not.
    addresses: {
      seattle: { street: "500 Pike St", city: "Seattle", state: "WA", zip: "98101" },
      tampa: { street: "120 Franklin St", city: "Tampa", state: "FL", zip: "33602" },
      default: { street: "1 Remote Way", city: "Denver", state: "CO", zip: "80202" },
    },
    acknowledged_at: "2026-07-01T00:00:00.000Z",
    acknowledged_policy: "auto-submit-v1",
    last_updated: "2026-07-22T19:00:00.000Z",
  };
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state, null, 2));

  // applied/: one collision with state.json, three md-only with varying provenance
  await fs.writeFile(
    path.join(root, "jobs", "applied", "acme-engineering-manager.md"),
    `---
url: https://boards.greenhouse.io/acme/jobs/123
company: Acme
title: Engineering Manager
location: Seattle, WA
source: greenhouse
---

## Job Description

Lead the platform team at Acme.
`,
  );
  await fs.writeFile(
    path.join(root, "jobs", "applied", "beta-director-data.md"),
    `---
slug: beta-director-data
company: Beta
title: Director, Data
location_raw: Remote, United States
url: https://www.beta.careers/job?gh_jid=555
resume: /abs/jane-doe-resume.pdf
resume_key: default
address_city_key: default
status: submitted
submitted_at: 2026-07-09T00:14:14Z
screenshot: screenshots/beta-director-data-confirmation.png
---
`,
  );
  await fs.writeFile(
    path.join(root, "jobs", "applied", "gamma-head-of-ai.md"),
    `---
url: https://jobs.ashbyhq.com/gamma/abc
company: Gamma
title: Head of AI
location: New York, NY
source: LinkedIn
applied_at: 2026-06-20T21:41:00Z
---
`,
  );
  await fs.writeFile(
    path.join(root, "jobs", "applied", "delta-senior-em.md"),
    `---
url: https://delta.com/jobs/1
company: Delta
title: Senior EM
location: Austin, TX
---
`,
  );

  // queue: two files (created in non-alphabetical order)
  await fs.writeFile(
    path.join(root, "jobs", "queue", "zeta-platform-em.md"),
    `---
url: https://zeta.com/jobs/9
company: Zeta
title: Platform EM
location: Remote
---
ATS: greenhouse
Req ID: 9
`,
  );
  await fs.writeFile(
    path.join(root, "jobs", "queue", "alpha-ai-director.md"),
    `---
url: https://alpha.wd5.myworkdayjobs.com/job/2
company: Alpha
title: AI Director
location: Tampa, FL
match: strong
llm_score: 4
llm_reasoning: strong AI platform match
---
ATS: workday
`,
  );

  // discovered: one scored file
  await fs.writeFile(
    path.join(root, "jobs", "discovered", "omega-staff-eng.md"),
    `---
url: https://omega.com/jobs/3
company: Omega
title: Staff Engineer
location: United States
source: greenhouse
llm_score: 2
discovered_at: 2026-06-24T21:13:47.919Z
---
`,
  );

  // credentials.json with a sentinel password
  const credentials = {
    "acme.wd5.myworkdayjobs.com": {
      username: "applicant+acme@example.com",
      password: SENTINEL_PASSWORD,
      email_used: "applicant+acme@example.com",
      ats: "workday",
      company: "Acme",
      created_at: "2026-07-22T17:00:00Z",
      last_used_at: "2026-07-22T17:05:00Z",
      last_login_status: "success",
      notes: "created during application",
    },
    "careers-beta.icims.com": {
      username: "applicant.alt@example.com",
      password: "hunter2",
      email_used: "applicant.alt@example.com",
      ats: "icims",
      company: "Beta",
      created_at: "2026-06-01T00:00:00Z",
    },
  };
  await fs.writeFile(path.join(root, "credentials.json"), JSON.stringify(credentials, null, 2));

  // `templates/` and a template-verbatim `profile.md`.
  //
  // THE WARNINGS INVERSION, and it is the only reason AC 6 is testable at all.
  // The LIVE profile yields ZERO parser warnings; the TEMPLATE yields exactly
  // one — "profile.md `## Identity` has no `- **Email:**` bullet"
  // (`.pi/extensions/lib/profile.ts:231`), because the template's Email bullet
  // is `<FILL IN>` at `:14` and `cleanValue`'s PLACEHOLDER (`:117`) resolves it
  // to null. A live-shaped fixture would make the banner permanently empty and
  // the criterion unfalsifiable.
  //
  // The screenshot fixture (`scripts/seedFixtureWorkspace.ts`) is deliberately
  // the OTHER one — drifted like the live file — because on real data the
  // orphan and absent-section states are the normal rendering path. Two
  // fixtures, two jobs; do not "fix" either into the other.
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.writeFile(
    path.join(root, "templates", "profile.template.md"),
    FIXTURE_PROFILE_TEMPLATE,
  );
  await fs.writeFile(path.join(root, "profile.md"), FIXTURE_PROFILE_TEMPLATE);

  // resumes/: against the template's `denver`/`chicago` region rules this gives
  // `default` -> "default", `denver` -> "region", `stale.pdf` -> "orphan",
  // `old.docx` -> "orphan" (wrong extension), and `chicago` -> a ruleGap.
  //
  // IT CANNOT PRODUCE "override" OR "shadowed", AND THAT IS CORRECT RATHER THAN
  // A GAP. The template ships its `- **Resume path:**` bullet INSIDE an HTML
  // comment (`profile.template.md:31`) and `parseProfile` strips comments
  // before parsing (`:339`), so there is no override to shadow anything. Those
  // two states are covered by the pure cases and by one route case that builds
  // its OWN fixture with the bullet uncommented. Do not uncomment it here —
  // every existing suite would silently get a profile with an active override.
  //
  // `.pdf` is in WATCH_IGNORED (`routes/events.ts:18`), so these perturb no SSE test.
  await fs.mkdir(path.join(root, "resumes"), { recursive: true });
  for (const name of ["default.pdf", "denver.pdf", "stale.pdf", "old.docx"]) {
    await fs.writeFile(path.join(root, "resumes", name), `stub ${name}\n`);
  }

  // gather_state.json (valid)
  const gather = {
    seen_urls: { "https://omega.com/jobs/3": { first_seen: "2026-06-24T21:13:47Z", source: "greenhouse", company: "Omega", title: "Staff Engineer", decision: "discovered" } },
    per_company: { omega: { last_fetched: "2026-06-24T21:14:15Z", openings_count: 10, matched_count: 1 } },
    last_full_gather: "2026-06-24T21:14:30.367Z",
    auto_promote: false,
  };
  await fs.writeFile(path.join(root, "gather_state.json"), JSON.stringify(gather, null, 2));

  return root;
}

export async function rmFixtureWorkspace(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const RUNS_AGENT_CONNECTION = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  label: "Runs agent",
  provider: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9001/v1",
};

/** Apply-ready profile + agent settings for supervised run HTTP tests. */
export async function seedRunsApplyReady(root: string): Promise<void> {
  const { setConnectionCredential } = await import("../providers/providerService");
  await fs.mkdir(path.join(root, "resumes"), { recursive: true });
  await fs.writeFile(path.join(root, "resumes", "default.pdf"), "stub default resume\n");
  await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
  await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      connections: [RUNS_AGENT_CONNECTION],
      agent: { connectionId: RUNS_AGENT_CONNECTION.id, modelId: "agent-model" },
      scoring: { connectionId: RUNS_AGENT_CONNECTION.id, modelId: "agent-model" },
      captcha: {},
    }),
  );
  await setConnectionCredential(root, RUNS_AGENT_CONNECTION.id, "runs-test-key");
}
