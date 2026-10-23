# Rolebound

**Rolebound** is a job-application agent that runs on your own machine. It finds postings
on public ATS boards, scores them against a profile you write, drives a real browser to
fill and submit applications, keeps the per-company ATS logins that Workday and friends
demand, and tracks everything in plain files you can read. You talk to it in a chat; the
forms for your profile, resumes, job search and settings sit one click away in the
Workspace drawer.

Internal package and workspace identifiers remain `pi-jobs` for compatibility (`npm start`,
`PI_JOBS_ROOT`, `.pi-jobs/`, and related paths are unchanged).

> **Read this first.** Rolebound submits job applications **in your name**, and by default
> it submits without asking you again for each one (after a one-time acknowledgement).
> You are responsible for the truth of everything it submits and for following each job
> site's terms of use; automating an ATS may break them. Rolebound is provided under the
> [MIT License](LICENSE), **without warranty of any kind**.

**The repo is the workspace.** Product code is tracked by git; everything about
you — `profile.md`, `state.json`, resumes, credentials, provider keys — is
gitignored and scaffolded from `templates/`. Shared agent and dashboard writes use
cross-process locks and atomic same-directory renames; corrupt JSON fails closed
with a repair path (`npm run restore`, `npm run doctor -- --repair`). See
[docs/workspace.md](docs/workspace.md).

## Availability

The source lives at <https://github.com/bbarney7/rolebound>. As of 2026-10-22 the
repository is **private**; the clone command below works for people with access and
will work for everyone once it is made public.

## Requirements

| | Supported |
| --- | --- |
| OS | macOS and Linux. CI runs on **macOS 15** and **Ubuntu 24.04**. Windows and WSL are **unverified** — they may work, but nobody has tested them. |
| Node.js | **24.14.0** is what CI and local releases are tested on (the pinned pi package needs at least 22.19.0; the optional Cursor provider needs Node 24+). |
| Browser | Google Chrome or Chromium. On Linux, install one yourself. |
| AI model | Your own account or API key with a supported provider (see below). |

Full pinned versions are in [docs/runtime-matrix.md](docs/runtime-matrix.md).

## Quick start

```bash
git clone https://github.com/bbarney7/rolebound.git rolebound && cd rolebound
npm ci             # exact pinned dependencies, including the pi agent
npm run setup      # scaffold your gitignored workspace files
npm run build      # production UI bundle → ui/dist/
npm start          # http://127.0.0.1:4747 (override: npm start -- --port N)
```

Other commands you will use:

```bash
npm run doctor            # readiness check: exit 0 ready, 1 blockers, 2 usage error
npm run doctor -- --repair  # finish interrupted promote/complete operations
npm run demo              # isolated synthetic demo; no external calls, no real agent
npm run demo -- --empty   # demo with a minimal seed only
npm run backup            # snapshot the workspace's private files
npm run restore           # roll back to a backup
```

After `npm start`, open the page and follow **Setup** (Connect AI → Resume & profile →
Find jobs → Ready to apply). If Rolebound detects an AI account already signed in on this
computer, click **Use this**; otherwise use **Sign in with Claude**, **Sign in with
ChatGPT**, **Sign in with GitHub Copilot** or **Sign in with Cursor**, or expand **Paste a
key instead** for API-key providers. You can also just start chatting: drop your resume into
the chat and ask it to fill in your profile.

`npm run demo` always uses its **own temporary workspace directory**. It **exits with code
2** if you pass `--root` or if `PI_JOBS_ROOT` is already set when demo starts. Your live
checkout is not used or modified, and the temp directory is removed when demo exits.

Development UI with Vite proxy:

```bash
npm run dev        # UI on 127.0.0.1:5173, API target from PI_JOBS_PORT (default 4747)
```

### Ports

| Port | Used by |
| --- | --- |
| 4747 | `npm start` and `npm run demo` (change with `--port` or `PI_JOBS_PORT`) |
| 5173 | `npm run dev` (Vite) |
| 14747 | Playwright browser tests |

Everything binds to `127.0.0.1`. Do not expose it to your network.

### AI models: bring your own

Rolebound never ships with a model or a key; you connect your own in **Setup** or
**Settings**. Two choices are stored in `settings.json` (schema v2):

- **Applying and chat model** — the model that drives the browser and talks to you. Chat
  and applying can use different models, and you can switch the chat model mid-conversation.
- **Scoring model** — optional override for scoring discovered jobs. Leave it unset and
  scoring uses the applying model.

Connections are kept as `connections[]` metadata in `settings.json`; the keys and sign-in
tokens themselves are stored under `.pi-jobs/` in the workspace (see
[SECURITY.md](SECURITY.md)). An environment variable can supply or override a key for a
run without writing it to disk. Optional CAPTCHA solver keys (2Captcha or CapSolver) live
in `settings.json`; exporting `TWOCAPTCHA_API_KEY` / `CAPSOLVER_API_KEY` only supplies the
key for a provider `settings.json` already names. Lever's hCaptcha needs 2Captcha.

### Upgrades, backups and restore

```bash
git pull
npm ci
npm run build
npm run doctor
```

`git pull` never deletes your gitignored files, but a newer version may **migrate** them in
place. Every migration writes a backup to `.pi-jobs/backups/` first, and `npm run restore`
rolls back (each restore also saves a `<timestamp>-pre-restore` backup). Backups contain your
secrets: never copy them into issues, chat or public forks.

### Verification

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list.

```bash
npm test && npm test --workspace ui
npm run server-smoke
npm run demo-smoke
npm run browser-test    # Playwright on port 14747
```

## Optional: direct `pi` CLI

You can also run the [pi coding agent](https://github.com/earendil-works/pi) from
the repo root. Extensions in `.pi/extensions/` auto-load and register the slash
commands below.

**Provider keys configured in the Settings UI apply to supervised runs launched
through `npm start`.** They are stored in this workspace's `settings.json` and
`.pi-jobs/` agent directory. A separately installed global `pi` in another
terminal does **not** automatically pick up those keys or connection choices unless
you run from this checkout with the same workspace files and agent directory
configuration yourself.

```
/gather              discover jobs from targets.md   → jobs/discovered/
/score-discovered    score each discovered job 1-5 with an LLM
/review-discovered   review, then promote the good ones → jobs/queue/
/apply-next          apply to the next queued job
/status              tracked applications and profile.md warnings
/acknowledge         versioned auto-submit acknowledgement
```

Then run `pi` from the repo root once Setup in the UI shows no blockers (or after editing
the same workspace files by hand).

### Browser MCP (`job-playwright`)

Application runs need Playwright MCP tools. Pi 1.0.4 loads them from **`.pi/mcp.json`**
in the checkout (not from the repo-root `.mcp.json`, which is kept for other MCP clients
such as Cursor). Tools are registered as `mcp__job_playwright__browser_*` (for example
`mcp__job_playwright__browser_navigate`).

- **Supervised UI runs** (`npm start` → Apply): the server passes `-a` / `--approve` to pi
  and copies `.pi/mcp.json` into the per-run `PI_CODING_AGENT_DIR`, so browser tools load
  without a separate setup step.
- **Terminal `pi` in this checkout:** the first time you run `pi` here, pi asks you to
  trust project-local files (extensions and `.pi/mcp.json`). Accept that prompt once; pi
  remembers the decision for this checkout. Without trust, MCP browser tools are not
  loaded.

Chrome (or Chromium) is required; session data lives under `.browser-data/` in the
workspace. Create `screenshots/` (included in a fresh setup) before confirmation
screenshots — Playwright resolves `browser_take_screenshot` paths against the workspace
root.

## How it fits together

| Piece | What it does |
|---|---|
| `.pi/extensions/job-gatherer.ts` | Polls public ATS JSON boards, filters by role/topic/location, dedups, writes `jobs/discovered/` |
| `.pi/extensions/job-applier.ts` | Resolves resume + address, drives the browser, tracks `state.json`, moves queue → applied |
| `.pi/extensions/submission-guard.ts` | Code-enforced submission boundaries (stop, ack, rate limit, evidence, and related gates) |
| `.pi/extensions/workspace-tools.ts` | Chat tools: read and edit profile sections, agent instructions, queue a job URL, import and extract resumes |
| `.pi/extensions/job-accounts.ts` | Creates and stores per-ATS-host accounts in `credentials.json` |
| `.pi/extensions/ats-adapters.ts` | Greenhouse shortcut: form schema from the public API, then generated fill / submit / security-code scripts — switchable off |
| `.pi/extensions/lib/adapters/` | The pure adapter logic — URL parsing, schema compaction, answer validation, script generation — and its tests |
| `.pi/extensions/lib/` | Workspace-root resolution, the `profile.md` parser, and the adapter switch |
| `.pi-jobs/scripts/<slug>-{fill,submit,otp}.js` | Browser scripts the Greenhouse adapter generates per application — gitignored, regenerated every run |
| `scripts/measure-session.mjs` | Turn / context accounting for a pi session JSONL: `node scripts/measure-session.mjs [path] [--json]` |
| `ui/` | Local web UI (**Rolebound**): stage navigation, discovery triage, supervised runs |
| `templates/` | Seeds for every file the agent writes |
| `CLAUDE.md` / `AGENTS.md` | The operating manual the agent reads |

`AGENTS.md` is inlined verbatim into the agent's system prompt on every run, so it
documents the agent workflow and the extensions that enforce its boundaries. Build
and test details stay in this README. The optional adapter is documented here
because with `PI_JOBS_ATS_ADAPTERS=0` the prompt has to be byte-identical to a
checkout without the adapter, and a paragraph in `AGENTS.md` would break that on its
own. `.pi/extensions/lib/ats-adapters.offpath.test.ts` fails if the tokens come back.

### Web UI layout

Browser tab title and product chrome use **Rolebound** (see [docs/brand.md](docs/brand.md)).
The chat is the home page (`/`): the agent's tool results show up inline as cards (jobs,
profile changes, run progress, applications), and questions it needs you to answer appear
as prompts in the transcript. The **Your search** rail summarises where things stand.

Everything else lives in the **Workspace** drawer (`nav[aria-label="Workspace sections"]`):
**Profile**, **Job search**, **Agent instructions**, **Applications**, **Settings** and
**Setup**. Deep links such as `/profile?tab=resumes`, `/discover`, `/queue` and
`/settings/accounts` open the drawer on that page.

The extensions share `.pi/extensions/lib/`: `workspace.ts` resolves the workspace
root from the module's own location, `profile.ts` parses `profile.md`, `config.ts` holds
the `PI_JOBS_ATS_ADAPTERS` switch and the slug guard that runs before any generated
script path is built, and `adapters/greenhouse.ts` is the adapter's whole public surface
over `adapters/greenhouse/` — `schema.ts` reads a posting (URL parsing, the Job Board API
fetch, schema compaction), `answers.ts` answers one (selectors, answer template,
validation), `scripts.ts` generates the fill / submit / OTP browser scripts. No applicant
detail is hardcoded in any extension; it all comes from `profile.md`.

## Tests

```bash
npm ci              # root dev dependencies (Vitest, TypeScript); separate from ui/
npm test            # vitest run — the adapter logic, the config switch, the off-path proof
npm run typecheck   # tsc --noEmit over .pi/extensions/lib/ and ats-adapters.ts
```

Root tests resolve `@earendil-works/pi-coding-agent` and `typebox` from the repo's
`node_modules` (see `docs/runtime-matrix.md` for pinned versions). No global pi
install is required for `npm ci`, `npm run build`, or `npm start`.

## Security and safety

See [SECURITY.md](SECURITY.md) for the full policy. Summary:

- **`credentials.json` is plaintext** on your disk, and `.browser-data/` holds live
  logged-in browser sessions. Both are gitignored. Treat the directory like a
  password store: it effectively is one.
- **The agent submits real applications on your behalf without per-application
  confirmation.** You own the accuracy of every submission. A one-time, versioned
  acknowledgement gate (`auto-submit-v1`) is required before the first one. See
  [SECURITY.md](SECURITY.md#automatic-submission).
- **Automating an ATS may violate its terms of service.** That is your call to make,
  not the tool's.
- **EEO / self-identification questions** default to "prefer not to answer". Change
  them in `profile.md` if you want different answers.
- **CAPTCHAs stop the run by default** (`captcha.provider: off`). Exporting a solver
  API key in the environment alone does not enable solving — you must select a
  provider in Settings. Each paid task bills your account. At most **two** paid
  provider tasks per application (persisted in `state.json` across stop/resume) and
  **20** per rolling 24 hours across the workspace by default (configurable). Lever
  hCaptcha requires 2Captcha. See [SECURITY.md](SECURITY.md#captcha).
- **Rate limit (code-enforced):** at most one application per ten minutes.
- **The UI binds to localhost.** Do not expose it.
- **Your data goes to the services you choose.** Profile, resume and job text go to your
  model provider; application answers go to the ATS sites you apply to; CAPTCHA challenges
  go to your solver if you turn one on. See [What leaves your machine](SECURITY.md#what-leaves-your-machine).

### ATS adapters and how to turn them off

On a Greenhouse posting the agent skips filling the form field by field: it reads the
form's schema from Greenhouse's public Job Board API, then runs three generated browser
scripts — one to fill, one to submit, one to enter the emailed security code. The scripts
land in `.pi-jobs/scripts/`, which is gitignored, and the adapter is **on by default**.

`.pi/extensions/ats-adapters.ts` registers four tools for it:

- `greenhouse_get_form` — a compact schema plus a blank answers object, from the public
  Job Board API. No job-description HTML.
- `greenhouse_prepare_fill` — checks an answers object against a re-fetched schema and,
  only if nothing is missing or wrong, writes the fill script and records which posting
  it belongs to.
- `greenhouse_prepare_submit` — writes the submit script and explains what each reported
  state (`submitted`, `otp_required`, `validation_errors`, `captcha`, `unknown`) means.
- `greenhouse_prepare_otp` — writes the script that enters the emailed security code.

Every generated script checks the browser's URL against the job it was written for before
it types or clicks anything, so a tab that drifted to another posting between two tool
calls returns `wrong page` rather than filling — or submitting — the wrong application.

#### Embedded boards

Not every Greenhouse posting is hosted by Greenhouse. A company careers site can mount the
same form in an iframe served from `…greenhouse.io/embed/job_app…`, and its URL then carries
`?gh_jid=<id>` without saying which board the job belongs to — pass the board slug (`board`)
or the company name (`company_hint`) to `greenhouse_get_form` and `greenhouse_prepare_fill`,
which read the schema from the Job Board API either way. The scripts find the form
themselves: each picks the embed frame when there is one and the page itself otherwise, and
the fill result's `frame` says which it used — `null` on a Greenhouse-hosted board, the
iframe URL on an embed.

An embedded form also takes a moment to become real. The fill script waits for it to stop
remounting before it types anything and then reads every text value back off the page, so
`filled` is what the form is holding rather than what was sent to it; a field the board never
rendered is reported as skipped instead of costing a timeout. A form that never appears comes
back as `form not found` — or `form not settled`, when it appears but keeps remounting — with
the frame URLs the page was showing, and the answer to both is to reload the posting and run
the same script once more.

Neither is the form's uploader ready the instant the form is, so files are attached last,
after every other field, and a file the page never confirms is attached up to three times
before the fill reports `upload not confirmed` — with whatever error the page put
beside the field. Two smaller shapes are worth knowing at the answers level. A question id
ending in `[]` is a multi-select, which is Greenhouse's own name for one, and is answered
under that exact key with the list of labels to pick; a board that renders a short one as a
group of checkboxes rather than a combobox is filled the same way — the fill checks the
boxes by their labels — so a `[]` question is answered under the same key either way. And a
submit that fails validation names each offending field by its own id, alongside the label
the page shows and Greenhouse's message, so the answer that has to change can be found
without reading the form.

The schema also carries one question Greenhouse itself never lists among `questions[]`:
`Location (City)` (id `candidate-location`) comes from `location_questions`, whose own id
belongs to a pair of hidden latitude/longitude fields the DOM never renders; the id used
here is the DOM's own `input#candidate-location`, because that is what a selector needs.
It is `unlisted_select`: the API enumerates no option list for it, so the schema carries
none and the fill accepts any non-empty string. The control is a type-ahead over
Greenhouse's own geocoder, and what it resolves a city name to is often fuller than what
was typed — `San Francisco` becomes `San Francisco, California, United States` — so
`filled` reports the resolved wording, not the typed one.

There is no `country` question, and the schema does not synthesize one. The page also
renders `input#country[role=combobox]`, but that control belongs to the phone widget, not
an address field — it is the dial-code selector, its only "United States" option reads
`United States +1`, and selecting it reformats the `phone` field. An earlier version of
this adapter synthesized a `country` answer aimed at that control; since answering a
dial-code selector with a country name is wrong on its own terms and corrupted `phone` on
every board, the synthesis was removed and the control is left alone.

The browser MCP kills any script at a fixed 60 seconds and returns nothing at all, so each
script stops short of that on its own clock: 30 s for the fill, 40 s for the submit's
post-click poll, 20 s for the security-code read-back. A fill that runs out of time returns
the fields it did fill with `reason: "deadline"` and the rest marked `out of time` — a
partial result the agent can act on, rather than a dead request. The generated source is
bounded too: the fill template stays under 6,144 bytes and the submit and security-code
templates under 4,096, which the adapter tests enforce.

#### Dry run against a live posting

`scripts/greenhouse-dryrun.mjs` fills a real posting in a real browser and blocks every write
on the way out, so a generated fill script can be checked against a live form without
submitting anything:

```bash
node scripts/greenhouse-dryrun.mjs <live-url> <answers.json> <resume.pdf> \
  [--board=<slug>] [--company-hint=<name>] [--json]
```

`scripts/greenhouse-dryrun.example.json` answers a Greenhouse-hosted posting;
`scripts/greenhouse-dryrun.datadog.example.json` is the embedded counterpart and needs
`--board=datadog`. Both hold placeholder values on purpose. The run prints every field it
filled beside what the page read back, and every request it blocked. One write is allowed
out of the browser and is expected exactly once: the resume upload, which Greenhouse's file
input POSTs to S3 the moment a file is attached. Everything else is blocked, and a PASS needs
zero of those blocks to have been *Greenhouse-bound* — any `*.greenhouse.io` host, or that
same S3 bucket — because those are the only hosts an application could be submitted to.
Anything else is listed as "also blocked — third-party telemetry, not submissions" and never
fails the run: on a company careers site that is the site's own analytics and ad pixels, and
a Greenhouse form cannot submit anywhere but Greenhouse.

#### Turning it off

To turn it off for good, add one line to `~/.zshrc`:

```bash
export PI_JOBS_ATS_ADAPTERS=0
```

Then open a **new terminal** — or run `source ~/.zshrc` in the one you already have —
and start pi there. Editing `~/.zshrc` does nothing to a shell that is already open, so
quitting pi and re-running it in the same terminal would leave the adapter on. To turn it
off for one session only, without touching `~/.zshrc`, start pi as
`PI_JOBS_ATS_ADAPTERS=0 pi`.

To confirm it took: `echo $PI_JOBS_ATS_ADAPTERS` prints `0`, and pi asked to list every
tool it has by exact name shows no `greenhouse_*` entries.

That is the whole rollback. With the switch off the extension registers nothing: the
agent's tool list and system prompt are byte-identical to a checkout without the adapter,
and Greenhouse postings go back through the ordinary browser-driven path. The heavier
alternative is `git revert` of the merge.

Accepted values — it is a plain local shell variable, nothing secret:

- unset, `1`, `true`, `all`, `on`, `yes` — every adapter on
- `0`, `false`, `off`, `none` — every adapter off
- a comma-separated list (`greenhouse`, `ashby`) — only those adapters
- anything else fails closed: every adapter off

Case and surrounding whitespace do not matter. A value containing a comma is always a
list, so `all,ashby` enables `ashby` alone — `all` is not an adapter's name.

## Your data never enters git

`.gitignore` covers `profile.md`, `state.json`, `gather_state.json`,
`credentials.json`, `settings.json`, `targets.md`, `APPLIED.md`, `jobs/**/*.md`,
`resumes/*`, `screenshots/*`, `/.pi-jobs/`, and `.browser-data*`.

Upgrades may **migrate** gitignored files in place; backups are written under
`.pi-jobs/backups/` before migration (`npm run restore` can roll back). Each
restore also writes a `<timestamp>-pre-restore` backup. Migrations preserve
unknown fields — they do not wipe your profile or application history. After
submit, the agent calls `complete_application` (not `mv`) so `state.json` stays
the source of truth. Full lock, corruption, and export rules:
[docs/workspace.md](docs/workspace.md).

`scripts/audit-personal-data.sh` greps the tree and git history for
personal-looking strings — run it before you push a fork anywhere public.

### Chat sessions

`POST /api/runs` with `{ "kind": "chat", "message": "..." }` starts a multi-turn session. Send later messages to `/api/runs/:id/reply`; abort or finish explicitly to release it. Page reloads replay the bounded conversation from `/api/runs/current` and `/api/runs/events?since=<seq>`. Conversation replay is in memory: a server restart starts a fresh chat.

`POST /api/chat/attachments` accepts one multipart `file` (PDF/DOCX/TXT/MD, at most 10 MiB), protected by the same host, origin and CSRF checks as other writes. It returns a relative `uploads/<unique-name>` path to include in a chat message. Uploaded files remain local and are excluded from git and release exports.

For chat runs, the `workspace-tools` extension exposes `profile_read`, `profile_update_section`, `queue_add_url`, `resume_add` and `resume_extract_text`. Section updates splice raw Markdown and preserve other sections. Profile writes use the UI's cross-process lock; queue creates use its exclusive atomic create; resume writes share a directory lock and the resume/run preparation guard with the UI. Resume inputs are confined to `uploads/` and `resumes/`. Only PDFs can become the application default; extraction runs locally with pdf2json and mammoth, with no OCR for scanned documents. In chat, a successful `update_application_state` selects the current job for submission guards; browser form actions require that selection and the existing acknowledgement, queue, submitted, and rate-limit gates. Sanctioned writes obey supervised run stop markers; the existing `STATE_DIRECT_WRITE` boundary remains enforced.

Tool results can carry `details.card` (`job-list`, `profile-diff`, `run-progress`, `application`, `connection`). The run stream preserves and redacts those payloads, and suppresses them entirely when run credentials cannot be read.

## Support and security reports

- **Questions and bugs:** open an issue on the GitHub repository. Never paste credentials,
  your profile, resumes, run transcripts or employer URLs tied to your identity — scrub logs
  first. [docs/support-walkthrough.md](docs/support-walkthrough.md) covers setup, `npm run
  doctor` codes and known limitations.
- **Security problems:** report privately through GitHub's **Report a vulnerability** button
  on the repository's Security tab, not in a public issue. See [SECURITY.md](SECURITY.md#reporting-issues).

Release notes are in [docs/release-notes.md](docs/release-notes.md).

## License

Rolebound is released under the [MIT License](LICENSE). Bundled fonts and icons, and the
proprietary `@cursor/sdk` package installed for the optional Cursor provider, keep their own
licenses; see [NOTICE.md](NOTICE.md).
