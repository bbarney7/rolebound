# Security

Rolebound (workspace name `pi-jobs`) is designed for **single-user, localhost-only** operation. Read this before
running the agent or web UI.

## Localhost binding

The web UI and API bind to `127.0.0.1` only. Default port is **4747**; override with
`--port` or `PI_JOBS_PORT`. Do not expose the server to your LAN or the public internet.

Mutating API requests require a CSRF token from `GET /api/session` and a matching
`Host` header. Cross-site and hostile-host requests are rejected.

## Plaintext secrets on disk

These files are **plaintext** and gitignored:

| File | Contents |
| --- | --- |
| `credentials.json` | ATS login usernames/passwords |
| `settings.json` | Provider connections, agent/scoring selection, CAPTCHA provider and API key |
| `.browser-data/` | Logged-in browser sessions |
| `.pi-jobs/pi-agent/auth.json` | Persistent provider API-key and OAuth credential store |
| `.pi-jobs/runs/*/pi-agent/auth.json` | Temporary per-run projection of the selected provider credentials |
| `.pi-jobs/chat-sessions/*.jsonl` | Saved chat transcripts (your messages, the agent's replies and tool results, which can include profile and resume text) |
| `uploads/` | Files you attach in chat |

Treat the workspace directory like a password store. Encrypt your disk at the OS level
if the machine is shared or portable.

Workspace backups under `.pi-jobs/backups/` (including automatic pre-restore snapshots)
contain the same secrets as live files. They are gitignored and excluded from
`npm run release:export`; do not copy them into tickets, chat, or public forks.

## What leaves your machine

Rolebound has no server of its own and collects no telemetry. Data leaves your machine only
to services you set up:

| Goes to | What | When |
| --- | --- | --- |
| Your AI model provider (OpenAI, Anthropic, Cursor, OpenRouter, …) | Your profile, resume text, agent instructions, the text of job postings and application pages the agent reads, your chat messages, and page snapshots/screenshots taken in the controlled browser | Every chat, scoring and application run. The provider's own retention and training terms apply. |
| The job sites and ATS systems you apply to | Your application answers, resume file, contact details and address, and any account you create there | When the agent fills and submits a form. |
| Public ATS job boards (Greenhouse, Ashby, Lever) | Board slugs from your targets; no personal data | When you gather jobs. |
| Your CAPTCHA solver (2Captcha or CapSolver), only if you turn one on | The page URL and the CAPTCHA widget's public site key (no form contents) | When a form shows a CAPTCHA. Each task is billed to your solver account. |
| Your email, only if you set it up | The agent reads verification-code emails through an authenticated `gmail` CLI or the controlled browser | When an ATS emails a one-time code. |

**Logs and transcripts.** Run transcripts and saved chat sessions are written in plaintext
under `.pi-jobs/`. Secrets the server knows about (provider keys, ATS passwords) are redacted
from the run event stream the UI shows, but your profile and resume text are not — they are
the agent's working material. Treat transcripts as private.

**Support reports.** Nothing is sent automatically. When you share output from
`npm run doctor`, a run transcript or a screenshot, scrub names, emails, phone numbers,
addresses, employer URLs and anything key-shaped first.

## Corrupt agent-shared JSON

Corrupt or empty `credentials.json`, `state.json`, `gather_state.json`, or
`.pi-jobs/captcha-spend.json` fail **closed** — tools and routes return an error and do
not replace bytes on disk with `{}`. Repair from backup or follow
[docs/workspace.md](docs/workspace.md). **Windows is unsupported** for durable storage
guarantees.

## Bring your own key (BYOK)

Provider API keys can be supplied two ways:

1. **Environment variables** — set the key named on the connection (or provider default).
   The UI shows `credentialSource: "environment"` in run snapshots when env supplied the key.
2. **App store** — saved under `.pi-jobs/` during a supervised run; never returned by
   read APIs.

Exporting `OPENAI_API_KEY` (or similar) does **not** write to `settings.json`. The UI
never echoes raw keys in JSON responses or run event streams (values are redacted).

Rolebound may read `~/.cursor/sdk`, `~/.claude`, `~/.codex`, `~/.config/gh`, and `~/.pi`
on your machine only to detect existing logins and offer sign-in shortcuts; it never copies
rotating OAuth tokens from other tools into the app store, and supervised Cursor runs set
per-run `CURSOR_DATA_DIR` so transcripts stay under the run directory instead of your global
Cursor profile.

## Automatic submission

Rolebound's default is **automatic submission**: once a form is complete and truthful,
the agent submits without asking you again for that application. That is deliberate,
not a bug.

- A **one-time**, versioned acknowledgement (`acknowledged_policy: auto-submit-v1`) is
  required before the first live application. Setup, Settings, and `/acknowledge` show the
  same disclosure. The acknowledgement is **not** per-application authorization.
- There is **no** per-application submit confirmation dialog in supervised runs.
- **Demo mode** (`npm run demo`) never contacts employers; it exercises a synthetic
  verification-code prompt only.

## What stops a submission

The table lists boundary ids **B1–B16** (enforced in code where noted). Tests and
extensions cite these ids in `// boundary: B<n>` comments. The submission guard sees pi
tools, including browser tools reached through Cursor's bridge, but not Cursor's own
Shell/Edit tools.

| ID | Boundary | Enforcement | Remaining limitation |
| --- | --- | --- | --- |
| B1 | Auto-submit disclosed before the first application | **Code.** Versioned ack is required by server run start, `/apply-next`, and the submission guard (apply-kind runs and slug-bearing calls). The guard blocks navigation and page scripts that name a local address, and blocks browser actions while the controlled browser is on the local dashboard, except navigation away, back, tab select/close/list, and browser close. Disclosure appears in Setup, Settings, and `/acknowledge`. | A terminal session's generic browser calls without a slug are not ack-gated (so account sign-in works); its scripts and solver calls are. The agent cannot record the ack through `write`/`edit` (`STATE_DIRECT_WRITE`); `bash` is only speed-bumped. The dashboard itself refuses foreign Host headers, cross-site requests and foreign origins. These checks are defence in depth, not a sandbox; `bash` remains an open gap. |
| B2 | One-time ack is not per-application authorization | Documentation and UI copy state it explicitly | — |
| B3 | Stopped or finished UI run starts no new browser, submit, or paid action | **Code.** Stop marker is checked on every action-class call (including MCP and `codemode` inner calls) plus a process-group kill. If the stop marker cannot be written, a warning is emitted and removing the run directory is attempted; shutdown always continues. State tools stay allowed so an in-flight result can be recorded. | If both marker write and directory removal fail, the tool fence cannot be persisted. An action already dispatched to the browser when Stop arrives can complete. It is then recorded from the persisted observation or the page. |
| B4 | Terminal `pi` session stop | Unchanged (pi's own Esc/abort) | No marker. Documented. |
| B5 | Removed queue item is not submitted | **Code.** DELETE stops the active run for that slug. The guard blocks mutating calls when the apply-context or tool slug's queue file is gone and the app is not submitted. Queue mutation tools are blocked in apply-kind runs and after Stop. The guard blocks navigation and page scripts that name a local address, and blocks browser actions while the controlled browser is on the local dashboard, except the escape actions listed in B15. Neither pi's `write`/`edit`, a browser tool's `filename`, nor inline `browser_run_code_unsafe` code can recreate a queue file. | Terminal generic browser calls carry no slug context, so this is prompt-only there. The dashboard itself refuses foreign Host headers, cross-site requests and foreign origins. These checks are defence in depth, not a sandbox; `bash` remains an open gap. |
| B6 | Dismissed (rejected) discovery is not applied to | **Code.** Only `jobs/queue/` is consumed. Promote and add mark the URL `promoted`. | — |
| B7 | No resubmission of a submitted application (retry/resume) | **Code.** Server apply start refuses. The guard blocks mutating calls and Greenhouse submit/OTP scripts for a submitted slug. Reopening needs the user's confirmation dialog, re-checked inside the state lock. The guard blocks navigation and page scripts that name a local address, and blocks browser actions while the controlled browser is on the local dashboard, except the escape actions listed in B15. Direct `write`/`edit` of `state.json` is blocked (`STATE_DIRECT_WRITE`). | Terminal generic calls without a slug are prompt-only. `bash` could still edit `state.json` or call the local dashboard API to answer its own dialog; the guard only speed-bumps the obvious forms. Documented here. The dashboard itself refuses foreign Host headers, cross-site requests and foreign origins. These checks are defence in depth, not a sandbox; `bash` remains an open gap. |
| B8 | Ten-minute rate limit | **Code.** Server start, `/apply-next`, guard (Greenhouse submit/OTP, apply context). `submitted_at` is stamped by the tool, not the agent. | Terminal free-form generic calls without a slug are prompt-only. |
| B9 | `submitted` needs genuine confirmation | **Code (partial).** Evidence fields and an existing screenshot are required. Greenhouse claims are cross-checked against the persisted observation of the script result. | For generic browser submit, deciding that the page shows a confirmation is still the model's judgment. The observation file and `screenshots/` are hard-blocked for `write`/`edit` but only speed-bumped for `bash`, so an agent could still forge them through `bash`. Documented. |
| B10 | Missing required information pauses | **Code** for the Greenhouse adapter (`validateAnswers`; no script while anything is unanswered). Prompt for generic browser submit. | Generic browser submit is prompt-only. |
| B11 | Address never fabricated | **Code** in `generate_address` | The model could still type a different address directly into a form (prompt-only). |
| B12 | CAPTCHA off by default; env alone cannot enable a solver | **Code** | — |
| B13 | CAPTCHA spend cap | **Code.** Unsafe tool slugs and mismatched apply-run slugs are rejected. Persistent per-application cap that counts provider tasks. `solve_captcha` is also blocked after Stop and for ineligible apps. Plus a persistent rolling 24-hour workspace cap (default 20). | Spend in a second Rolebound workspace on the same provider key is not counted |
| B14 | Manual CAPTCHA/OTP dialogs end on Stop | **Code** (`cancelPendingDialogs`) | — |
| B15 | Browser driven outside the MCP pipeline | **Code (partial).** `write`/`edit` to protected paths (state/config files, `.pi-jobs/`, `jobs/`, `screenshots/`, all of `.pi/`, `ui/`, `scripts/`, `node_modules/`, `package.json`, `package-lock.json`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`) are hard-blocked (`STATE_DIRECT_WRITE`). Inline or non-generated `browser_run_code_unsafe` is hard-blocked (`UNSAFE_CODE`). Browser-tool `filename` writes are confined to `screenshots/` and `.playwright-mcp/`. The guard scans navigation URLs and page-script text for local addresses (`OFF_PIPELINE_BROWSER`). It remembers the last Page URL reported by the MCP and blocks browser actions on the local dashboard, including after redirects; browser actions are serialized so that a navigation's landing page is checked before the next browser action. Only navigation to a non-local HTTP(S) URL or `about:blank`, back, tab select/close/list, and browser close are allowed there. The dashboard itself refuses foreign Host headers, cross-site requests and foreign origins. `bash` is speed-bumped on a pattern list. | **Open gap:** `bash` can still run its own Playwright, edit files or call the local dashboard API. URL scanning is best-effort and page tracking depends on MCP-reported Page URLs; a result without one preserves the previous URL. These checks are defence in depth, not a sandbox. |
| B16 | Demo never submits | **Code** (synthetic runner). The demo asks for a fictional verification code instead of a submit confirmation the product does not have. | — |

## Verification codes

Greenhouse and other ATS flows often require an email one-time code. The agent may:

- Use an installed, authenticated `gmail` CLI to search and read messages when HTML
  bodies are available.
- Open Gmail in the **controlled** Playwright browser (`job-playwright` profile) and
  read the list or message snapshot when the CLI strips HTML.
- Call `request_manual_verification` so you paste the code or confirm completion in the
  supervised UI.

Rolebound does **not** silently harvest mail from providers you have not configured. It
does not bypass MFA outside the paths above.

## CAPTCHA

- **Off by default** (`captcha.provider: "off"`). With the solver off, the agent stops
  for you to complete CAPTCHA in the controlled browser.
- Exporting `CAPSOLVER_API_KEY` or `TWOCAPTCHA_API_KEY` alone **never** enables a solver;
  `settings.json` must select a provider.
- Each paid provider task bills your CapSolver or 2Captcha account.
- At most **2** paid provider tasks per application (`captcha_paid_tasks` in
  `state.json`), kept across stop and resume.
- At most **N** paid tasks per rolling **24 hours** across the workspace (default **20**,
  configurable 1–200 in Settings). A corrupt `.pi-jobs/captcha-spend.json` blocks paid
  tasks until repaired.
- Set a **provider-side balance limit** as a second safeguard.
- **Lever hCaptcha** requires the **2Captcha** provider.

**Demo mode** blocks provider catalog fetches, connection tests, CAPTCHA tests, and real
pi spawns.

## Rate limit

At most **one** application submission per **ten minutes**, measured from the newest
non-demo `submitted_at` (or `reopened_from_submitted_at`). Enforced at apply-run start
and by the submission guard. Demo mode is exempt.

## Reporting issues

- **Security vulnerabilities:** report them privately with GitHub's **Report a
  vulnerability** button on the repository's Security tab. Do not open a public issue.
  Include the commit or release you ran, steps to reproduce, and what an attacker gains.
- **Everything else:** open a normal issue. Do not include credentials, profile data,
  resumes, transcripts, or employer URLs tied to your identity; scrub logs before sharing.

Rolebound is single-user, localhost software provided under the MIT License without
warranty. There is no bug bounty and no guaranteed response time.
