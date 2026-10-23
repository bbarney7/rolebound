# Applicant Profile

This file is the source of truth for application form fills. The agent reads it at
the start of every application, and the extensions parse the tables and bullets
below for resume, address, and job-filtering rules. Copy it to `profile.md` in the
workspace root and replace every `<FILL IN>`.

`profile.md` is gitignored — it never leaves your machine.

## Identity

- **Full name:** <FILL IN>
- **Preferred name / first name on forms:** <FILL IN>
- **Email:** <FILL IN>
- **Fallback email:** *(optional — used only when an ATS signup form rejects `+aliasing`)*
- **Phone:** <FILL IN>
- **LinkedIn:** <FILL IN>
- **GitHub:** *(none — skip if optional; if required, leave blank or "N/A")*
- **Portfolio / website:** *(none — skip if optional; if required, leave blank or "N/A")*
- **Pronouns:** <FILL IN>

## Resume

By default the agent picks `resumes/<resume_key>.pdf` for the matched region and
falls back to `resumes/default.pdf`. Put at least `resumes/default.pdf` in place.

If you use one resume for every application, uncomment the bullet below and point
it at that file — a workspace-relative path (`resumes/default.pdf`) or an absolute
one. When this bullet is present it overrides the per-region lookup entirely.

<!-- - **Resume path:** `resumes/default.pdf` -->

### Resume region rules (`resume_key`)

Which resume file a job location maps to. Delete rows you do not have a resume
for — an unmatched location falls back to `default`.

| `resume_key` | Match terms |
|---|---|
| `denver` | denver, boulder, colorado, co |
| `chicago` | chicago, evanston, illinois, il |

## City → Address rules (`address_city_key`)

Distinct from `resume_key`. The address map (`state.json.addresses`) is keyed by
these specific cities so two jobs in the same metro but different cities don't
collapse onto one address.

`Match terms` is optional — the display city always matches. The longest matching
term wins, so a metro-wide term ("front range") on one row beats a bare city name
on another.

| `address_city_key` | Display "City, State" | Match terms | ZIP (reference only; Rolebound never generates an address) |
|---|---|---|---|
| `denver` | Denver, CO | denver, front range | 80202, 80203, 80206 |
| `chicago` | Chicago, IL | chicago, chicagoland | 60601, 60614, 60622 |
| `default` | Remote — agent stops if a real address is required for a Remote-only role | remote, anywhere | n/a |

### City normalization rules

- Lowercase, strip punctuation, hyphenate spaces (`San Francisco` → `san-francisco`).
- `Remote` / `Anywhere` (with or without modifiers) → `default`, regardless of other text.
- If a posting names multiple cities, pick the most specific one explicitly listed.
- If a posting's city matches no row above and `default` (Remote) is inappropriate
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
  > Use `[COMPANY]` where the company name goes.>

  Substitute `[COMPANY]` with the company name. Adjust a phrase or two per posting;
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

Read by the gatherer. Every bullet is optional — omit one and the extension's
built-in defaults apply for that dimension only.

- **Target roles:** <FILL IN — e.g. product designer, design systems, staff engineer>
- **Target level:** <FILL IN — e.g. senior, staff, director>
- **Target topics:** ai, agentic, agent, ml, machine learning, llm, platform, inference
- **Target locations:** remote, united states
- **Title blocklist:** intern, new grad, early career, vp, chief, sales, customer success

## Candidate summary

<!--
Everything below this comment, verbatim, is what the gatherer sends to the scoring
model with each discovered job. Keep it short — it is prepended to every scoring
request. Delete this whole section and the gatherer composes a summary from
`## Identity` and `## Work history` instead.
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

> Use the address persisted in `state.json.addresses[<address_city_key>]` for the
> matched city. If it is missing, ask the user for their truthful address and call
> `generate_address` with exactly that address to persist it. Never fabricate an address.
