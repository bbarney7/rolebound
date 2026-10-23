# Greenhouse Job Board API fixtures

Unauthenticated public responses from the Greenhouse Job Board API, captured with
`?questions=true` so the application-form schema (`questions`, `compliance`,
`demographic_questions`, `location_questions`) is included. They exist so the adapter's
Vitest suite can assert against real payload shapes without network access.

No applicant data is present in these files. They describe job postings and the empty
form schema an applicant would fill in, not any submission.

## Why `content` was removed

The `content` key (the job-description HTML, 12,317 bytes for amplitude, 12,714 bytes for
anthropic, 11,091 bytes for datadog and 14,054 bytes for mozilla) was deleted from all four
files: it is never returned to the model and it is large enough to dominate every diff.
Every other key is byte-for-byte as returned; the files are only pretty-printed (2-space
indent, trailing newline).

## The four jobs, and why all four

They are asymmetric, and the adapter has to handle every branch:

| | `amplitude-8654510002.json` | `anthropic-5304425008.json` | `datadog-8041594.json` | `mozilla-7947405.json` |
|---|---|---|---|---|
| `questions` | 10 | 21 | 14 (16 fields, one of them the `multi_value_multi_select` `question_67918863[]` with 45 options — the first `[]` id in any fixture) | 21 (23 fields, one of them the required `multi_value_multi_select` `question_67089406[]` with 10 options) |
| `compliance` | `null` | 4-element array (one entry has an empty `questions` array) | 4-element array (first entry has an empty `questions` array; then `disability_status`, `veteran_status`, `race`, `gender`, all `multi_value_single_select`, none required) | `null` |
| `demographic_questions` | object | `null` | `null` | object whose `questions` array has 8 entries |
| `location_questions` | `[]` | `[]` | `[]` | 3-element array: `Longitude` (`longitude`, `input_hidden`, required), `Latitude` (`latitude`, `input_hidden`, required), `Location` (`location`, `input_text`, required) |
| `data_compliance` | 1-element `gdpr` entry | 1-element `gdpr` entry | 1-element `gdpr` entry | 1-element `gdpr` entry |
| `resume` file field + `resume_text` textarea twin | yes | yes | yes | yes |

`compactSchema` keeps 20 questions from datadog: its 16 fields plus the four compliance
questions.

mozilla is the reason the fourth fixture exists: it is the only posting here whose
`location_questions` is populated, so it is the only one that exercises the `Location (City)`
combobox and the dropping of its two `input_hidden` siblings.

## Provenance

### `amplitude-8654510002.json`

- Command: `curl -sS 'https://boards-api.greenhouse.io/v1/boards/amplitude/jobs/8654510002?questions=true'`
- Retrieved: 2026-08-28T13:55:27Z
- HTTP status: 200
- `shasum -a 256` of the committed (content-stripped) file:
  `cb3cdd918699a0985fa4b92808df53a617810737cfc6bae4f0ed60d96d3a450b`

### `anthropic-5304425008.json`

- Command: `curl -sS 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/5304425008?questions=true'`
- Retrieved: 2026-08-28T13:55:27Z
- HTTP status: 200
- `shasum -a 256` of the committed (content-stripped) file:
  `67629317c1ec36a195d6eed31b5bd11e396e4682bdc9111676a1a422023f67a1`

### `datadog-8041594.json`

- Command: `curl -sS 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs/8041594?questions=true'`
- Retrieved: 2026-08-31T13:42:25Z
- HTTP status: 200
- `shasum -a 256` of the committed (content-stripped) file:
  `9d5be63a9bae9c2a933bffc8a94a10498993fc168f06d8b5040734830e163a03`

### `mozilla-7947405.json`

- Command: `curl -sS 'https://boards-api.greenhouse.io/v1/boards/mozilla/jobs/7947405?questions=true'`
- Retrieved: 2026-09-02T12:30:45Z
- HTTP status: 200
- Bytes of the committed (content-stripped) file: 21,191
- `shasum -a 256` of the committed (content-stripped) file:
  `c57308a256537cc660ecbd1a370b3837dd164e5076e493a0e7020c0a2b284554`

## Re-capturing

```sh
curl -sS 'https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);delete o.content;process.stdout.write(JSON.stringify(o,null,2)+"\n")})' \
  > <board>-<id>.json
```

Then update the timestamp and checksum above. Job postings close, so a re-capture may
404; do not substitute a different posting without updating this file and the counts the
adapter tests assert.
