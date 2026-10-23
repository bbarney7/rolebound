# Job Applier Agent

This directory is a pi-native job application automation workspace. The repo *is*
the workspace: product code is tracked, and everything about you — profile, state,
jobs, resumes, credentials — is gitignored and scaffolded from `templates/`.

Supervised runs are normally started from the local web UI (`npm start` in the
repo root). You operate on the same workspace files whether the human drives you
from that UI or from a direct `pi` session in this checkout.

In this checkout, pi's own `write`/`edit` tools cannot modify Rolebound code or workspace state (`STATE_DIRECT_WRITE`); contributors edit the code with their editor or another coding agent.

## Extensions

Five pi extensions auto-load when running pi from this directory:

- `.pi/extensions/job-applier.ts` — the application automation agent. Injects the applier workflow into the system prompt and registers custom tools/commands (`/apply-next`, `/status`, `/acknowledge`, `/tracker`).
- `.pi/extensions/submission-guard.ts` — code-enforced submission boundaries. Blocks browser-mutating, submit, and paid tool calls when policy requires (stop, missing ack, submitted slug, rate limit, and related cases). See [SECURITY.md](SECURITY.md#what-stops-a-submission).
- `.pi/extensions/job-gatherer.ts` — the discovery agent. Pulls job postings from public ATS JSON APIs (Greenhouse, Ashby, Lever), filters them against the target profile, dedups against applier state, and writes candidates to `jobs/discovered/` for review before promotion to `jobs/queue/`. Registers `/gather`, `/gather-greenhouse <slug>`, `/score-discovered`, `/review-discovered`, `/targets`, `/gather-status`.
- `.pi/extensions/job-accounts.ts` — the ATS account manager. Handles login walls on Workday/iCIMS/SmartRecruiters/etc. by looking up or creating accounts, resetting passwords, and tracking all credentials in `credentials.json`. Registers `get_account`, `create_account`, `login_to_ats`, `reset_password`, `list_accounts`, `update_account` tools.

A fifth extension provides Greenhouse form/schema tools when enabled (on by default here). It is documented in `README.md` so the agent prompt stays identical when that extension is switched off.

They share `.pi/extensions/lib/` — `workspace.ts` (resolves the workspace root from
the module's own location) and `profile.ts` (parses `profile.md`). No applicant
detail is hardcoded in any extension; it all comes from `profile.md`.

## Configuration the human maintains

Before `/apply-next` or `/gather`, the human should have:

- `profile.md` filled in (identity, work history, Q&A bank, resume/address rules)
- `resumes/default.pdf` (or a profile-declared resume path)
- `targets.md` with at least one ATS company list
- `settings.json` with a chosen **agent** connection and model (`agent.connectionId`,
  `agent.modelId`), optional **scoring** override, and optional **captcha** settings

Provider connections live in `settings.json` `connections[]`. Keys saved through
the Settings UI are stored under `.pi-jobs/` in this workspace. Supervised UI runs
use that app-scoped store. A global `pi` install in another terminal does not
automatically inherit those keys — the human must run from this checkout with the
same workspace configuration.

## Commands

- `/apply-next` — start applying to the next queued job
- `/status` — show tracked application status (and any `profile.md` warnings)
- `/acknowledge` — one-time versioned auto-submit acknowledgement
- `/gather` — discover jobs from all ATS sources in `targets.md` → `jobs/discovered/`
- `/gather-greenhouse <slug>` — gather from a single Greenhouse board
- `/score-discovered` — batch-score all unscored discovered jobs with an LLM (writes `llm_score` 1–5 + reasoning into frontmatter)
- `/review-discovered` — list discovered jobs sorted by LLM score, promote strong matches to `jobs/queue/`
- `/targets` — show the curated target company list
- `/gather-status` — show gather state (last gather, seen URLs, per-company stats)
- Or just say: "gather some jobs" or "score the discovered jobs"

## Key files

| File | Purpose | Tracked? |
|------|---------|----------|
| `profile.md` | Applicant identity, work history, Q&A bank, resume + address rules | no — from `templates/profile.template.md` |
| `state.json` | Application tracking, address persistence, acknowledgment state | no |
| `credentials.json` | ATS login credentials (plaintext, local-only) | no |
| `settings.json` | Provider connections, agent model, optional scoring override, CAPTCHA provider/key (plaintext, local-only) | no — from `templates/settings.json` |
| `targets.md` | Company list for the gatherer, grouped by ATS source | no — from `templates/targets.template.md` |
| `gather_state.json` | Gatherer state: seen URLs, per-company fetch stats, auto_promote flag | no |
| `jobs/queue/<slug>.md` | Pending job postings with frontmatter (applier consumes) | no |
| `jobs/applied/<slug>.md` | Completed postings (moved after submit) | no |
| `jobs/discovered/<slug>.md` | Gatherer staging area (review → promote to `jobs/queue/`) | no |
| `resumes/*.pdf` | Your resumes; `default.pdf` is required | no |
| `screenshots/<slug>-confirmation.png` | Submit confirmation screenshots | no |
| `ui/` | Local web UI over the same files | yes |

## Storage and durability

Agent tools and the dashboard share the lock table and atomic write rules in
[docs/workspace.md](docs/workspace.md). Corrupt or empty `credentials.json`,
`state.json`, or `gather_state.json` fail closed (no silent `{}` overwrite).
Queue completion is `complete_application`, not a shell `mv`. Backups under
`.pi-jobs/backups/` are secret-bearing and local-only; never commit or share them.
`npm run doctor -- --repair` reconciles interrupted operations when no supervised
run is active. Windows is unsupported.

## MCP servers

`.pi/mcp.json` registers the `job-playwright` MCP server for browser automation with a
persistent user-data dir (`./.browser-data`), so ATS logins survive between runs.

## Resume selection

`profile.md` decides. If its `## Resume` section sets a `Resume path`, that one file
is used for every application. Otherwise the agent uses `resumes/<resume_key>.pdf`
for the region matched by the `### Resume region rules` table, falling back to
`resumes/default.pdf`. If neither exists the agent stops and asks.

## Address matching

`address_city_key` comes from the `## City → Address rules` table in `profile.md` —
each row declares a city and its match terms (an optional ZIP column is reference-only;
Rolebound never generates an address from ZIPs). The longest matching term wins.
Addresses are persisted per city in `state.json.addresses` and reused. If a location
matches no row and Remote is inappropriate, the agent stops and asks rather than
inventing one. When an address is missing, ask the user for their truthful address and
call `generate_address` with exactly that address to persist it.

## Submission policy

Rolebound submits each application automatically after the one-time versioned
acknowledgement (`acknowledged_policy: auto-submit-v1`). That acknowledgement is not
per-application authorization. Code-enforced boundaries (stop marker, queue removal,
submitted lock, rate limit, evidence for `submitted`, CAPTCHA caps, and related gates)
are summarized in [SECURITY.md](SECURITY.md#what-stops-a-submission) with ids **B1–B16**.
When a tool call is blocked by the submission guard, stop and report — do not retry
through another tool, `bash`, or a separate process.

## Email addresses for ATS accounts

`job-accounts` builds `<your-email-local>+<company>@<domain>` from the `## Identity`
email in `profile.md` so all ATS mail lands in one inbox. If a signup form rejects
`+aliasing`, it retries with the optional `Fallback email` bullet; without one it
stops and asks.
