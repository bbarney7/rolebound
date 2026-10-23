# Support walkthrough

This guide walks a new user from install through gather, score, review, promote, and
supervised apply. It matches the PJR-23 fresh-user pilot (Phase A). Anything marked
**unverified** has not been exercised with a real paid provider or live employer site in
Phase B.

## 1. Prerequisites

### macOS (supported)

- **Node.js** `>= 22.19.0` (`24.14.0` is what CI tests). Doctor prints `BLOCKED node: …`
  when the runtime is too old.
- **npm** (bundled with Node). Doctor prints `BLOCKED npm: missing` when `npm` is not on
  `PATH`.
- **Google Chrome** installed under `/Applications` (doctor checks common Chrome paths).
- **Disk space** for `node_modules`, the UI build (`ui/dist/`), and workspace files
  (`profile.md`, resumes, `.browser-data/`).
- **Windows is unsupported** for durable storage and doctor repair guarantees (see
  [docs/workspace.md](workspace.md)).

### Linux (supported)

- Same Node and npm requirements as macOS.
- **Chrome or Chromium** on `PATH` (`google-chrome`, `chromium`, or `chromium-browser`).
- Same workspace and browser-profile expectations as macOS.

### Out of scope for this release

- **Windows / WSL** — not tested; do not rely on doctor repair or atomic writes there.
- **Ambient cloud providers** — Amazon Bedrock, Google Vertex, Azure, and Cloudflare
  variants need extra credentials; not exposed in Settings yet.

## 2. Clean install and doctor

From a fresh clone (or a `release:export` tree):

```bash
npm ci
npm run setup      # scaffold gitignored workspace files
npm run build      # production UI → ui/dist/
npm start          # http://127.0.0.1:4747 (override: npm start -- --port N)
npm run doctor     # exit 0 = apply-ready, 1 = blockers, 2 = usage error
```

After `npm run setup` and `npm run build`, `npm run doctor` on a fresh export reports
lines like the following (recorded from a real export on macOS; your Node/npm/browser
lines will match your machine):

```
workspace: "/path/to/export"
OK node: 22.22.1
OK npm: 10.9.4
OK pi package: 1.0.4
OK browser: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
OK browser profile: created on first browser run
OK workspace: initialized
OK build: ready
RECONCILE R9: APPLIED.md stale (run npm run doctor -- --repair)
BLOCKED setup:connection
BLOCKED AGENT_MODEL_MISSING: Choose an agent connection and model.
BLOCKED setup:profile
BLOCKED NAME_MISSING: Add your full name.
BLOCKED EMAIL_MISSING: Add a valid email address.
BLOCKED PROFILE_PLACEHOLDERS: Replace template placeholders in Identity, Work history, Education, Authorization, Q&A bank.
BLOCKED setup:resume
BLOCKED RESUME_MISSING: Upload and select a default or global PDF resume.
BLOCKED setup:targets
BLOCKED TARGETS_PLACEHOLDER: Replace the example targets with real company board slugs
BLOCKED setup:readiness
BLOCKED AGENT_MODEL_MISSING: Choose an agent connection and model.
BLOCKED NAME_MISSING: Add your full name.
BLOCKED EMAIL_MISSING: Add a valid email address.
BLOCKED PROFILE_PLACEHOLDERS: Replace template placeholders in Identity, Work history, Education, Authorization, Q&A bank.
BLOCKED RESUME_MISSING: Upload and select a default or global PDF resume.
BLOCKED ACKNOWLEDGEMENT_MISSING: Acknowledge automatic submission before applying.
READY capability browse
BLOCKED capability discover
BLOCKED capability apply
```

Doctor also checks the default UI port (`4747`, or `--port`). If another process owns the
port, you will see `BLOCKED port <p>: in use — stop the other process or run npm start -- --port <n>`.
If Rolebound is already listening, doctor may print `OK port <p>: Rolebound already running`
instead.

Use `npm run doctor -- --repair` to apply reconciler fixes (stale `APPLIED.md`, interrupted
promote/complete operations). Without `--repair`, reconciler rows are report-only.

## 3. UI onboarding

Work in the web UI at `http://127.0.0.1:4747` (or your `--port`). The **Setup** view tracks
five steps: connection, profile, resume, targets, and readiness (acknowledgement).

1. **Connection** — Open **Setup** (or **Settings**). Rolebound scans this computer for
   accounts you already use elsewhere and lists them under **Detected accounts** (see
   [§4](#4-connect-a-provider)). Click **Use this** to connect in one step when adoption is
   safe, or to start Rolebound's own browser sign-in when tokens must not be copied. If
   nothing matches, use **Sign in with Claude**, **Sign in with ChatGPT**, **Sign in with
   GitHub Copilot**, or **Sign in with Cursor**; expand **Paste a key instead** only when you
   need a catalog API-key provider. Defaults for agent (and scoring when possible) are chosen
   automatically on adopt or successful sign-in. Until this step completes, Setup shows
   `AGENT_MODEL_MISSING` or related provider blockers.
2. **Profile** — **Profile → Identity**: full name and email (required). Fill **Work history**,
   **Education**, **Authorization**, and the **Q&A bank**; remove every `<FILL IN …>` placeholder
   the template ships with. Edit **Candidate summary** in the UI (it is sent to the scorer
   verbatim).
3. **Resume** — **Profile → Resumes**: upload a PDF and set a default (or a global resume path
   in profile rules).
4. **Targets** — **Discover**: replace the example `example-co` slugs in `targets.md` with real
   Greenhouse, Ashby, or Lever board slugs from your target companies.
5. **Readiness / acknowledgement** — On **Setup**, read the automatic-submission disclosure and
   acknowledge once (`acknowledged_policy: auto-submit-v1`). This is **not** per-application
   authorization; it only records that you understand Rolebound submits completed forms without
   asking again for each job ([SECURITY.md](../SECURITY.md)).

When every blocker is cleared, Setup shows all steps complete, doctor exits `0`, and
`BLOCKED capability apply` becomes `READY capability apply`.

## 4. Connect a provider

Setup and Settings show **ProviderSetup** above your saved connection cards: detected
accounts first, subscription sign-in buttons second, and **Paste a key instead** collapsed
last. Keys and OAuth credentials saved through the UI live under `.pi-jobs/pi-agent/auth.json`
in the workspace; environment variables can still override API keys per run without writing
to disk ([SECURITY.md](../SECURITY.md#bring-your-own-key-byok)).

### Detected accounts

On load the server calls `GET /api/providers/detected`. It reads **presence and metadata
only** from local stores (never tokens in API responses). Each row is one **Use this**
button.

| Source | Where it is read | What you see | **Use this** does |
| --- | --- | --- | --- |
| Cursor SDK | `<home>/.cursor/sdk/auth.json` | Cursor label, email, key expiry | **Adopt** — copies the dashboard key into Rolebound and sets agent defaults (expired keys start sign-in instead) |
| Claude Code | `<home>/.claude/.credentials.json`, else macOS Keychain service `Claude Code-credentials` | Claude Pro/Max label, refresh expiry when known | **Sign in** — creates the connection and starts Rolebound's Anthropic OAuth (Claude Pro/Max); does **not** copy Claude Code tokens |
| Codex CLI | `<home>/.codex/auth.json` | ChatGPT Plus/Pro label, last refresh | **Sign in** — OpenAI Codex OAuth; does **not** copy Codex tokens |
| GitHub CLI | `<home>/.config/gh/hosts.yml` plus `gh auth status -h github.com` | GitHub user; note that Copilot is verified at sign-in | **Sign in** — GitHub Copilot device flow |
| pi global auth | `<home>/.pi/agent/auth.json` | Per catalog provider | **Adopt** for `api_key` entries (key copied); **Sign in** for `oauth`; TypeSafe keys can **Use for scoring** |
| Environment | process env for catalog `apiKeyEnv` | Provider name | **Adopt** with `source: environment` (nothing written to the app store) |

Rotating OAuth tokens from Claude Code, Codex, GitHub CLI, or pi global OAuth are **never
copied** into Rolebound; that would sign you out of the other tool on the next refresh.
Those detections only offer a one-click path into Rolebound's own pi login.

### Sign in (subscription providers)

When a provider is not detected (or you add another account), use the sign-in row. Exact
button labels:

- **Sign in with Claude** — Claude Pro/Max (`anthropic` OAuth via pi).
- **Sign in with ChatGPT** — ChatGPT Plus/Pro (`openai-codex` OAuth via pi).
- **Sign in with GitHub Copilot** — GitHub account; optional **GitHub Enterprise…** link
  for an enterprise domain before the device-code step. You can instead expand **Paste a key
  instead**, choose `github-copilot`, and paste `COPILOT_GITHUB_TOKEN`.
- **Sign in with Cursor** — Cursor account; copy under the button says it **bills to your
  Cursor plan** (not an API-key product).

These subscriptions bill to **your** plan with that vendor; Rolebound does not resell
inference.

**Browser behavior:** the UI opens a sign-in window during your click. When the session
returns an `authUrl`, that window navigates there (Cursor uses the same popup with
`openBrowser: false`, so you do not get a second tab). GitHub Copilot shows a **device
code** and opens `verificationUri`. If the popup is blocked, follow **Open sign-in page**.
When Anthropic or Codex loopback ports (`53692`, `1455`) are busy, pi falls back to a
**paste authorization code** field in the UI — complete login there instead of the callback.
After a server restart, an in-flight login reports **interrupted**; start again.

On an **existing Cursor connection card**, **Use my existing Cursor login** re-imports
from `<home>/.cursor/sdk/auth.json` without starting browser login.

Supervised Cursor runs write transcripts under `<run dir>/cursor-data` (not your global
`~/.cursor/projects` tree).

### Paste a key instead

Expand **Paste a key instead** for catalog providers that support API keys (OAuth-only
`openai-codex` is omitted). Fill label, provider kind, and key; **Save connection** creates
the card. Use this for OpenRouter, TypeSafe (Jev scoring), Google, or any registry provider
when you are not using subscription sign-in.

### Saved cards, models, and test

Each connection card keeps **Test connection**, **Remove**, and the agent/scoring pickers
below. OAuth connections are probed through pi (`getAuth`) and the isolated model registry,
not a hand-built `GET /models` call.

### API-key providers (pi registry)

Each row is a Settings **provider kind** (`provider` on the connection). Use the listed
environment variable for BYOK or paste the key in the connection form.

| Kind (`provider`) | Display name | Default env var |
| --- | --- | --- |
| `ant-ling` | Ant Ling | `ANT_LING_API_KEY` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `baseten` | Baseten | `BASETEN_API_KEY` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `fireworks` | Fireworks | `FIREWORKS_API_KEY` |
| `google` | Google | `GEMINI_API_KEY` |
| `github-copilot` | GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| `groq` | Groq | `GROQ_API_KEY` |
| `huggingface` | Hugging Face | `HF_TOKEN` |
| `kimi-coding` | Kimi For Coding | `KIMI_API_KEY` |
| `meta` | Meta | `META_API_KEY` |
| `minimax` | MiniMax | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax CN | `MINIMAX_CN_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `moonshotai` | Moonshot AI | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | Moonshot AI CN | `MOONSHOT_API_KEY` |
| `nvidia` | NVIDIA | `NVIDIA_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `opencode` | OpenCode Zen | `OPENCODE_API_KEY` |
| `opencode-go` | OpenCode Go | `OPENCODE_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `qwen-token-plan` | Qwen Token Plan | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-cn` | Qwen Token Plan CN | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `qwen-token-plan-individual` | Qwen Token Plan Individual | `QWEN_TOKEN_PLAN_API_KEY` |
| `together` | Together | `TOGETHER_API_KEY` |
| `typesafe` | TypeSafe | `TYPESAFE_API_KEY` |
| `vercel-ai-gateway` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `xai` | xAI | `XAI_API_KEY` |
| `xiaomi` | Xiaomi | `XIAOMI_API_KEY` |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan AMS | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan CN | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan SGP | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `zai` | Z.AI | `ZAI_API_KEY` |
| `zai-coding-cn` | Z.AI Coding CN | `ZAI_CODING_CN_API_KEY` |

**Example (OpenRouter agent):** add connection → provider `openrouter` → paste
`OPENROUTER_API_KEY` → choose a catalog model → **Test connection**.

### OpenAI compatible

- Kind: `openai-compatible`.
- Set **Base URL** (and optional API style). Loopback hosts (`127.0.0.1`, `localhost`, `::1`)
  may run **without** a stored key; remote endpoints require a key.
- **Example:** local mock at `http://127.0.0.1:PORT/v1` for tests; production use your vendor's
  OpenAI-compatible URL.

### Cursor

- Kind: `cursor`. **Requires Node 24+** for supervised runs that load `pi-cursor-sdk`; below
  that, readiness reports `CURSOR_NODE_VERSION` with message "Cursor needs Node 24+".
- Connect via detected SDK login, **Sign in with Cursor**, **Use my existing Cursor login**
  on a saved card, or paste a dashboard API key under **Paste a key instead**.
- **Scoring:** Cursor is agent-only. A Cursor-only setup finishes with `scoring: null` and
  readiness `SCORING_MODEL_MISSING` until you add a scoring-capable connection (TypeSafe/OpenRouter
  Jev, another API-key provider, or inherit when the agent provider supports scoring).
- Real Cursor sign-in, bridge behavior, and model catalog against production are **unverified**
  until Phase B on Node 24.14.0.

Pinned packages: `pi-cursor-sdk@0.5.3` and `@cursor/sdk@1.0.37` (proprietary license; see
[docs/runtime-matrix.md](runtime-matrix.md)).

### Scoring override

- By default, discovery **scoring** uses the same connection and model as the **agent**.
- In **Settings**, enable the scoring override and pick a different connection/model when you
  want a cheaper or specialized scorer.
- Readiness codes:
  - `SCORING_MODEL_MISSING` — "Choose a scoring model" when the agent is Cursor (or the
    override points at Cursor).
  - `CREDENTIAL_MISSING` — scoring connection has no key (names the connection label).
  - `PROFILE_PLACEHOLDERS` — candidate summary or other score sections still contain template
    placeholders (score-specific message).

### Jev scoring (brief 13)

**Scoring only** — Jev cannot drive the apply agent (`AGENT_MODEL_MISSING` with "Jev can only
score jobs; choose an agent model" if you select Jev as the agent).

Configure Jev as the scoring model via either:

- **OpenRouter** connection with model `typesafe/jev-1.13` or `~typesafe/jev-latest`, or
- **TypeSafe** connection (`typesafe`) with model `jev-latest` and `TYPESAFE_API_KEY`.

The scorer builds a one-line **reason** from Jev's yes/no answers and fit index, for example:
`Jev: good fit (p=0.82). Level match likely (0.91); skills overlap likely (0.88); location fit likely (0.76).`

Because a **Cursor agent** does not expose standalone completions, Cursor users must set a
separate scoring connection (OpenRouter/TypeSafe Jev or any other completion-capable model).

Jev's live answer shape against production APIs is **unverified** until the pre-freeze canary
(T5b step 9); fixture tests cover parsing and scoring logic only.

### Test connection and provider error codes

**Test connection** hits the provider catalog (`GET /models` or equivalent). Failures return a
machine-readable `code` in the API response:

| Code | Typical cause | What to do |
| --- | --- | --- |
| `CONFIG_INVALID` | Bad base URL, duplicate label, unsafe path, invalid key format | Fix the connection form; use a literal API key |
| `CONNECTION_MISSING` | Stale connection id | Refresh Settings; recreate the connection |
| `CREDENTIAL_MISSING` | No key in app store or env | Paste a key or export the env var |
| `AUTH_REJECTED` | HTTP 401/403 from provider | Rotate the key; check account access |
| `QUOTA_EXCEEDED` | HTTP 429 | Wait or raise provider limits |
| `UPSTREAM_TIMEOUT` | Provider slow or offline | Retry; check network |
| `UPSTREAM_UNAVAILABLE` | Other upstream errors or oversized body | Retry later; check vendor status |
| `REVISION_CONFLICT` | Settings changed under another tab | Reload Settings and retry |
| `RUN_BUSY` | Active supervised run | Stop the run, then edit connections |

Readiness (doctor and `/api/readiness`) uses overlapping codes such as `MODEL_UNAVAILABLE`,
`TOOLS_UNSUPPORTED`, `CREDENTIAL_EXPIRED` ("Sign in again" when OAuth refresh failed or a
Cursor key expired), and `CONFIG_INVALID` when agent and scoring are two OAuth connections
of the same provider (use one connection for both roles, or an API-key connection for one
role). Warnings (not exit blockers) include `MODEL_UNVERIFIED` (Cursor model not in bundled
catalog) and `CURSOR_LOGIN_EXPIRING` (key expires within 14 days).

Paid CAPTCHA providers and every real-provider behavior beyond loopback fixtures are
**unverified** until Phase B.

## 5. Gather, score, review, promote, and apply

### Discover pipeline

1. **Gather now** — fetches public ATS JSON for slugs in `targets.md` → `jobs/discovered/`.
   Requires `discoverReady` (valid targets, no placeholder-only list).
2. **Score unscored** — LLM or Jev scoring writes `llm_score` and reasoning into discovered
   job frontmatter. Requires `scoreReady` (agent + scoring credentials and no score placeholders).
   Scoring runs two concurrent workers with retries on 429/5xx/timeouts.
3. **Review** — sort by score; **Dismiss** or **Promote** to `jobs/queue/`.
4. **Apply** — supervised run from the queue (Setup must show apply ready and acknowledgement
   recorded).

### Stop

- **Stop** in the run panel writes a stop marker, kills the pi process group, and blocks further
  browser, submit, and paid tool calls for that run ([SECURITY.md](../SECURITY.md) B3).
- An action already in flight may still complete; the agent records what the page showed.

### Manual OTP

- When an ATS asks for email/SMS verification, the run panel shows a prompt. Enter the code
  from your inbox; the agent continues after the UI delivers it to pi.

### CAPTCHA

- **Default:** CAPTCHA solving is **off** (`captcha.provider: off`). The run pauses with a
  manual CAPTCHA prompt; you solve it in the browser and confirm in the panel.
- **Optional BYOK:** set `captcha.provider` to `2captcha` or `capsolver` and add an API key in
  Settings. Spend caps apply per application and per workspace ([SECURITY.md](../SECURITY.md)
  B12–B13). Paid solver behavior is **unverified** until Phase B.

### Apply acknowledgement reminder

Automatic submission is intentional: once fields are complete and truthful, the agent submits
without a per-job confirmation dialog. The one-time acknowledgement does not authorize each
employer individually.

## 6. Backup, restore, upgrade, and repair

### Backup

```bash
npm run backup
```

Creates a timestamped snapshot under `.pi-jobs/backups/` with: `profile.md`, `targets.md`,
`settings.json`, `state.json`, `gather_state.json`, `credentials.json`, and `jobs/**/*.md`.
Refuses to run while a supervised run is active.

**Not backed up:** `resumes/*.pdf` and the persistent provider credential store
(`.pi-jobs/pi-agent/auth.json`). Temporary per-run credential projections live at
`.pi-jobs/runs/*/pi-agent/auth.json` and are removed with their run directories. Copy resumes
yourself; re-enter provider credentials after moving to a new machine.

### Restore

```bash
npm run restore -- --list
npm run restore -- --backup <id>
```

`--list` shows backup ids, dates, and file counts. Restore applies a backup and writes a
`-pre-restore` safety snapshot first. Refused during an active run. Restoring does **not**
recreate deleted PDFs under `resumes/`.

### Upgrade

```bash
git pull
npm ci
npm run build
npm run doctor
```

Gitignored workspace files survive `git pull`; newer versions may migrate them with backups.
After upgrading from pre–auto-submit-v1 acks, doctor shows `ACKNOWLEDGEMENT_LEGACY` until you
re-acknowledge in Setup.

### Corrupt `state.json`

A zero-byte or invalid `state.json` yields `STATE_CORRUPT` in doctor and a repair banner in
the UI. Restore from backup or use doctor repair flows documented in [docs/workspace.md](workspace.md).

## 7. Symptom → doctor code → fix

Infrastructure lines (from `scripts/doctor-readiness.mts`):

| Doctor line | Fix |
| --- | --- |
| `BLOCKED node: … is too old` | Install Node 22.19+ (24.14.0 tested) |
| `BLOCKED npm: missing` | Install Node/npm |
| `BLOCKED pi package: missing` | Run `npm ci` in the clone |
| `BLOCKED browser: missing — …` | Install Chrome (macOS `/Applications`) or Chromium on PATH (Linux) |
| `BLOCKED workspace: setup required` | Run `npm run setup` |
| `BLOCKED build: run npm run build` | Run `npm run build` |
| `BLOCKED port <p>: in use — …` | Free the port or `npm start -- --port <n>` |
| `BLOCKED setup:<step>` | Complete that Setup step (see blockers below) |
| `BLOCKED capability discover` | Fix targets blockers |
| `BLOCKED capability apply` | Fix connection, profile, resume, and acknowledgement blockers |
| `BLOCKED capability score` | Fix scoring connection, credentials, and profile placeholders for score |

Readiness blockers (from `ui/server/readiness.ts`, echoed as `BLOCKED <code>: <message>`):

| Code | Message (abridged) | Fix |
| --- | --- | --- |
| `AGENT_MODEL_MISSING` | Choose an agent connection and model | Settings → agent model; do not pick Jev as agent |
| `CURSOR_NODE_VERSION` | Cursor needs Node 24+ | Upgrade Node for Cursor runs |
| `CREDENTIAL_MISSING` | Add credentials for \<label\> | Paste key or set env var |
| `CREDENTIAL_EXPIRED` | Sign in again | Use **Sign in with …** on the connection card, or refresh OAuth via a new login |
| `CONFIG_INVALID` | Two OAuth connections of the same provider… | Use the same connection for agent and scoring, or an API-key connection for one role |
| `MODEL_UNAVAILABLE` | Model not in catalog / reasoning unsupported | Pick a catalog model; adjust thinking level |
| `TOOLS_UNSUPPORTED` | Model cannot accept text for tools | Pick an agent-capable model |
| `SCORING_MODEL_MISSING` | Choose a scoring model | Scoring override when agent is Cursor |
| `PROFILE_MISSING` | Create profile.md | Run setup or open Profile |
| `CANDIDATE_SUMMARY_MISSING` | Add a candidate summary or fill in Identity and Work history | Profile → Candidate summary |
| `NAME_MISSING` | Add your full name | Profile → Identity |
| `EMAIL_MISSING` | Add a valid email address | Profile → Identity |
| `PROFILE_PLACEHOLDERS` | Replace template placeholders… | Edit listed profile sections in UI |
| `RESUME_MISSING` | Upload and select a default… PDF | Profile → Resumes |
| `TARGETS_MISSING` | Add at least one valid ATS target | Discover → targets |
| `TARGETS_PLACEHOLDER` | Replace example targets… | Real board slugs in targets |
| `ACKNOWLEDGEMENT_MISSING` | Acknowledge automatic submission… | Setup acknowledgement |
| `ACKNOWLEDGEMENT_LEGACY` | Rolebound now states plainly… | Re-acknowledge in Setup |
| `STATE_CORRUPT` | state.json is corrupt… | Restore or repair per workspace docs |

Doctor warnings (exit code may still be `1` from other blockers):

| Code | Meaning |
| --- | --- |
| `MODEL_UNVERIFIED` | Cursor model id not in bundled catalog |
| `CURSOR_LOGIN_EXPIRING` | Cursor key expires within 14 days |

## 8. Known unresolved blockers and limitations

### Carried from PJR-15 (SECURITY.md B-table)

These boundaries are enforced in code where noted, but documented gaps remain:

| ID | Limitation |
| --- | --- |
| B1, B5, B7, B15 | Terminal `pi` sessions and `bash` are not fully fenced; generic browser calls without a slug are prompt-only. The dashboard rejects hostile hosts, but this is defence in depth, not a sandbox. |
| B3 | If stop marker write and run-dir removal both fail, the tool fence may not persist; an in-flight browser action may still complete. |
| B7, B9 | `bash` could edit `state.json` or forge screenshots despite `write`/`edit` blocks. |
| B8 | Rate limit is prompt-only for terminal generic calls without apply context. |
| B9 | Generic browser submit confirmation is still model judgment; Greenhouse has stronger checks. |
| B10 | Non-Greenhouse apply paths rely on prompts for missing fields. |
| B11 | Address fabrication is blocked in `generate_address`, but the model could type a different address in a form. |
| B13 | CAPTCHA spend in another workspace on the same provider key is not counted. |
| B15 | Off-pipeline browser use is partially code-enforced; not all paths are blocked. |

Cursor adds the same class of gap as `bash`: the submission guard sees pi tools (including
browser tools through the Cursor bridge) but not Cursor's own Shell/Edit tools
([SECURITY.md](../SECURITY.md)).

### PJR-23 Phase A status

- **Phase B not run:** real UI onboarding on the owner's profile, real-provider smoke, and
  supervised apply on a live posting are still unchecked without owner authorization.
- **Unverified until Phase B:** paid CAPTCHA solving, each real provider's production behavior
  (including Cursor on Node 24.14.0), and live gather against public ATS boards at scale.
- **Jev unverified** against live OpenRouter/TypeSafe until the T5b pre-freeze canary passes.
- **No open engineering blockers** from T1–T7 remain in this branch beyond the limitations above;
  anything larger found in walkthrough would be filed as a follow-up ticket rather than fixed
  silently in the pilot.
