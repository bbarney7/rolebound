# Applicant Profile

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
