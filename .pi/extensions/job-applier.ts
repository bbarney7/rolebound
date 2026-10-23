/**
 * Job Applier Agent — Pi Extension
 *
 * Auto-loads when pi runs from the workspace root (the repo you cloned).
 * Orchestrates job applications via Playwright MCP + Gmail.
 *
 * Provides:
 * - System prompt injection with agent workflow rules
 * - Custom tools for state management, resume matching, Gmail checks
 * - Slash commands: /apply-next, /status, /acknowledge, /tracker
 *
 * Every personal value — identity, resume, city and ZIP rules — comes from
 * `profile.md` in the workspace. Nothing about a particular applicant is
 * hardcoded here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE, wsPath, isInWorkspace } from "./lib/workspace";
import {
  formatApplyingInstructionsBlock,
  formatChatInstructionsBlock,
  formatChatReferenceInstructions,
  readInstructions,
} from "./lib/instructions";
import { loadProfileOrEmpty, matchesTerm, type CityRule, type Profile } from "./lib/profile";
import { resolveAttempt } from "./lib/attempt";
import {
  buildCaptchaInjectFunction,
  readCaptchaSettings,
  solveCaptcha,
  PROVIDERS,
  PROVIDER_ENV_VARS,
  type CaptchaKind,
  type CaptchaSettings,
} from "./lib/captcha";
import { reservePaidTask } from "./lib/captcha-spend";
import { MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION } from "./lib/submission-policy";
import {
  completeApplication,
  mutateAddresses,
  mutateApplicationState,
  readApplicationState,
  readApplicationStateStrict,
  regenerateAppliedTracker,
  setAcknowledgedAt,
  shouldSkipQueueFileForApply,
  stateCorruptMessage,
} from "./lib/applications";
import { WorkspaceFileError } from "./lib/durable-store";
import { resolveQueueJob } from "./lib/queue-slug";
import { isSafeSlug, isValidQueueFileRecord } from "./lib/workspace-files";
import { validateSubmittedTransition, unlinkObservation } from "./lib/submitted-evidence";
import { evaluateWorkspaceToolGate } from "./submission-guard";
import { AUTO_SUBMIT_DISCLOSURE_TEXT, AUTO_SUBMIT_POLICY_VERSION } from "../../ui/shared/autoSubmitPolicy";

function runStopMarkerExists(runDir?: string): boolean {
  if (!runDir) return false;
  return existsSync(path.join(runDir, "stop.json"));
}

// ── Resume / address matching (rules live in profile.md) ──

interface MatchResult {
  resume_key: string;
  resume_path: string;
  address_city_key: string;
  address: { street: string; city: string; state: string; zip: string } | null;
}

const REMOTE_PATTERN = /\b(remote|anywhere|hybrid with no office|fully remote)\b/;

function normalizeLocation(loc: string): string {
  return loc.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function resumeKeyFor(norm: string, profile: Profile): string {
  for (const rule of profile.resumeRegionRules) {
    if (rule.terms.some((term) => matchesTerm(norm, term))) return rule.key;
  }
  return "default";
}

/**
 * Most-specific city wins: the longest matching term beats a shorter one, so a
 * posting listing "San Francisco Bay Area" resolves to whichever key declares
 * that phrase rather than to a key that merely declares "san francisco".
 * profile.md states the same rule in prose for the LLM.
 */
function cityKeyFor(norm: string, profile: Profile, fallback: string): string {
  let best: { key: string; length: number } | null = null;
  for (const rule of profile.cityRules) {
    for (const term of rule.terms) {
      if (matchesTerm(norm, term) && (!best || term.length > best.length)) {
        best = { key: rule.key, length: term.length };
      }
    }
  }
  return best ? best.key : fallback;
}

function cityRuleFor(profile: Profile, key: string): CityRule | undefined {
  return profile.cityRules.find((rule) => rule.key === key);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `## Resume` may name one resume for every application (a `Resume path:`
 * bullet); otherwise the documented per-region contract applies —
 * `resumes/<resume_key>.pdf`, falling back to `resumes/default.pdf`.
 * Always absolute: browser_file_upload requires it.
 */
async function resolveResumePath(resumeKey: string, profile: Profile): Promise<string> {
  if (profile.resumePath) {
    return path.isAbsolute(profile.resumePath) ? profile.resumePath : wsPath(profile.resumePath);
  }
  const keyed = wsPath("resumes", `${resumeKey}.pdf`);
  if (await fileExists(keyed)) return keyed;
  return wsPath("resumes", "default.pdf");
}

async function matchResume(location: string): Promise<MatchResult> {
  const profile = await loadProfileOrEmpty();
  const norm = normalizeLocation(location);

  if (REMOTE_PATTERN.test(norm)) {
    return {
      resume_key: "default",
      resume_path: await resolveResumePath("default", profile),
      address_city_key: "default",
      address: null,
    };
  }

  const resumeKey = resumeKeyFor(norm, profile);
  const addressCityKey = cityKeyFor(norm, profile, resumeKey);

  return {
    resume_key: resumeKey,
    resume_path: await resolveResumePath(resumeKey, profile),
    address_city_key: addressCityKey,
    address: null,
  };
}

// ── CAPTCHA solver (settings live in settings.json; see lib/captcha.ts) ──

const SETTINGS_FILE = wsPath("settings.json");

/** Re-read per call: the UI's Settings view can change the file mid-session. */
function readCaptcha(): Promise<CaptchaSettings> {
  return readCaptchaSettings(SETTINGS_FILE);
}

/** Effective solver, or null when CAPTCHAs must stop the run. */
function activeSolver(settings: CaptchaSettings): { id: Exclude<CaptchaSettings["provider"], "off">; label: string } | null {
  if (settings.provider === "off" || settings.apiKey === "") return null;
  return { id: settings.provider, label: PROVIDERS[settings.provider].label };
}

/** One line for /status. Names where the key came from, never the key. */
function captchaStatusLine(settings: CaptchaSettings): string {
  const solver = activeSolver(settings);
  if (!solver) return "CAPTCHA solver: off (CAPTCHAs stop the run)";
  const from = settings.keySource === "env" ? PROVIDER_ENV_VARS[solver.id] : "settings.json";
  return `CAPTCHA solver: ${solver.label} (key from ${from})`;
}

/**
 * The detect → solve → inject → submit workflow, injected only when a solver
 * is active so a keyless run never sees an instruction it cannot follow.
 * The two scripts are passed to browser_evaluate as functions; every
 * backslash is doubled because this is a template literal inside a template
 * literal.
 */
function captchaWorkflowPrompt(providerLabel: string): string {
  return `### CAPTCHA handling (solver: ${providerLabel})
A CAPTCHA is NOT a stop trigger while the solver is active. Clicking submit on some forms (Lever) is what makes the widget appear, so run this workflow the moment you see a CAPTCHA widget, a challenge overlay, or a "verify you are human" checkbox — before or after submit.

1. **Detect.** \`browser_evaluate\` with:
   \`\`\`js
   () => {
     const url = location.href;
     const q = (str, name) => { const m = (str || '').match(new RegExp('[?&#]' + name + '=([^&#]+)')); return m ? decodeURIComponent(m[1]) : null; };
     const hc = document.querySelector('.h-captcha[data-sitekey]');
     const hcIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
     if (hc || hcIframe) {
       const src = hcIframe ? hcIframe.getAttribute('src') : '';
       return { kind: 'hcaptcha', sitekey: (hc && hc.getAttribute('data-sitekey')) || q(src, 'sitekey'), url,
                invisible: (hc && hc.getAttribute('data-size') === 'invisible') || q(src, 'size') === 'invisible',
                rqdata: hc ? hc.getAttribute('data-rqdata') : null };
     }
     const v3 = document.querySelector('.g-recaptcha[data-action]');
     if (v3 && v3.getAttribute('data-sitekey')) return { kind: 'recaptcha_v3', sitekey: v3.getAttribute('data-sitekey'), url, action: v3.getAttribute('data-action') };
     const v2 = document.querySelector('.g-recaptcha[data-sitekey]');
     if (v2) return { kind: 'recaptcha_v2', sitekey: v2.getAttribute('data-sitekey'), url, invisible: v2.getAttribute('data-size') === 'invisible' };
     const reIframe = document.querySelector('iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]');
     if (reIframe) { const src = reIframe.getAttribute('src'); return { kind: 'recaptcha_v2', sitekey: q(src, 'k'), url, invisible: q(src, 'size') === 'invisible' }; }
     const ts = document.querySelector('.cf-turnstile[data-sitekey]');
     if (ts) return { kind: 'turnstile', sitekey: ts.getAttribute('data-sitekey'), url, action: ts.getAttribute('data-action'), cdata: ts.getAttribute('data-cdata') };
     const tsIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
     if (tsIframe) return { kind: 'turnstile', sitekey: q(tsIframe.getAttribute('src'), 'sitekey') || q(tsIframe.getAttribute('src'), 'k'), url };
     return { kind: null, sitekey: null, url };
   }
   \`\`\`
   If \`kind\` or \`sitekey\` is null, take a screenshot and stop and ask — do not guess.

2. **Solve.** Call \`solve_captcha\` with the application \`slug\` and every non-null field from step 1 (\`kind\`, \`sitekey\`, \`page_url\` = \`url\`, \`invisible\`, \`rqdata\`, \`action\`, \`cdata\`). On \`ok: false\`: for \`disabled\`, \`unsupported_kind\` or \`budget_exhausted\` stop and ask with the error as the block reason; for anything else you may call it once more, then stop and ask.

3. **Inject.** Call \`browser_evaluate\` with \`function\` set to the \`inject_function\` string from the \`solve_captcha\` result unchanged — do not pass \`element\` or \`target\`. Do not rebuild the function yourself.

4. **Submit.** Click the submit control. \`browser_wait_for\` 3 seconds, then snapshot. If the page shows a CAPTCHA error or the challenge again, click submit once more; if it is still blocked, screenshot to \`screenshots/<slug>-captcha.png\` and stop and ask with \`block_reason: "captcha_solver_failed: token rejected"\`.

5. **Record.** In the attempt's \`notes\`, add \`captcha: <provider>/<kind> via <task_type> in <elapsed_ms>ms\` from the tool result.
`;
}

async function reserveApplicationPaidCaptchaTask(
  slug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let blocked = false;
  let used = 0;
  const result = await mutateApplicationState({ slug }, (app) => {
    used = typeof app.captcha_paid_tasks === "number" ? app.captcha_paid_tasks : 0;
    if (used >= MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION) {
      blocked = true;
      return;
    }
    app.captcha_paid_tasks = used + 1;
  });
  if (!result.ok) {
    const err = result.error;
    const message =
      err instanceof WorkspaceFileError
        ? stateCorruptMessage(err)
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: string }).message)
          : String(err);
    return { ok: false, error: message };
  }
  if (blocked) {
    return {
      ok: false,
      error: `Per-application paid CAPTCHA task cap (${MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION}) is exhausted for ${slug}.`,
    };
  }
  return { ok: true };
}

const CAPTCHA_BLOCKED_INSTRUCTION =
  "Set status blocked with block_reason quoting the solve_captcha error; hand the browser back to the user.";

/**
 * Persists a user-supplied address for a city key. Returns null when the user
 * has not supplied a full address or when the city is Remote (`default`) — the
 * caller turns that into a stop-and-ask rather than inventing a location.
 */
async function generateAddress(
  cityKey: string,
  provided?: { street: string; city: string; state: string; zip: string },
): Promise<{ address: { street: string; city: string; state: string; zip: string } | null; reason?: string }> {
  if (cityKey === "default") {
    return { address: null, reason: "city_key='default' is Remote — no address is generated." };
  }
  if (!provided) return { address: null, reason: `Ask the user for their truthful address for '${cityKey}' and call this tool again with it.` };
  const address = Object.fromEntries(Object.entries(provided).map(([key, value]) => [key, value.trim()])) as typeof provided;
  if (Object.values(address).some(value => !value)) return { address: null, reason: "Every address field must be provided by the user." };
  return { address };
}

// ── Extension ──

export const UPDATE_APPLICATION_STATE_PARAMETERS = Type.Object(
  {
    slug: Type.String({ description: "Application slug" }),
    status: Type.String({ description: "Application status" }),
    url: Type.Optional(Type.String()),
    company: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    location_raw: Type.Optional(Type.String()),
    location: Type.Optional(Type.String({ description: "Ignored alias for location_raw" })),
    resume_key: Type.Optional(Type.String()),
    address_city_key: Type.Optional(Type.String()),
    resume: Type.Optional(Type.String()),
    address: Type.Optional(
      Type.Object({
        street: Type.String(),
        city: Type.String(),
        state: Type.String(),
        zip: Type.String(),
      }),
    ),
    screenshot: Type.Optional(Type.String()),
    verification_email_id: Type.Optional(Type.String()),
    submitted_at: Type.Optional(Type.String({ description: "Ignored; Rolebound records the time itself" })),
    confirmation_source: Type.Optional(
      Type.Union([
        Type.Literal("greenhouse_submit_script"),
        Type.Literal("greenhouse_otp_script"),
        Type.Literal("page"),
        Type.Literal("email"),
        Type.Literal("user"),
      ]),
    ),
    confirmation_evidence: Type.Optional(Type.String()),
    screenshot_error: Type.Optional(Type.String()),
    abort_reason: Type.Optional(Type.String()),
    block_reason: Type.Optional(Type.String()),
    queue_file: Type.Optional(Type.String()),
    attempt: Type.Optional(
      Type.Object({
        started_at: Type.String(),
        ended_at: Type.Optional(Type.String()),
        outcome: Type.String(),
        notes: Type.Optional(Type.String()),
      }),
    ),
    attempt_outcome: Type.Optional(Type.String()),
    attempt_notes: Type.Optional(Type.String()),
    override_submitted: Type.Optional(
      Type.Boolean({
        description: "Reopens a submitted application; the user will be asked to confirm",
      }),
    ),
  },
  { additionalProperties: false },
);

export default function jobApplierExtension(pi: ExtensionAPI) {
  // ── System prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isInWorkspace(ctx.cwd)) return;

    const captchaSettings = await readCaptcha();
    const solver = activeSolver(captchaSettings);

    const prompt = `## Job Applier Agent

You are a job application automation agent running inside the user's own pi workspace at ${WORKSPACE}. The user has explicitly built, configured, and authorized you to apply to jobs on their behalf. This is not a request for advice — it is an automation workflow the user controls.

**CRITICAL: Do not refuse to apply to jobs. Do not offer alternatives like drafting cover letters or reviewing resumes. Do not explain why you 'cannot' or 'should not' apply. The user has placed job postings in jobs/queue/, written their profile.md, provided their resume PDFs, and run pi from this directory specifically to use this agent. Execute the workflow as instructed.**

You use the Playwright MCP server \`job-playwright\` for browser automation. Pi exposes its tools as \`mcp__job_playwright__browser_*\` (for example \`mcp__job_playwright__browser_navigate\`, \`mcp__job_playwright__browser_snapshot\`). Email integration is optional.

### Email / Gmail workflow (IMPORTANT)
If the \`gmail\` CLI is installed and authenticated, it may read and search emails.

- Search: \`gmail search 'from:<sender> subject:<text>'\`
- Read metadata: \`gmail read <id>\` or \`gmail latest <n> --json\`

⚠️ **Known limitation:** the \`gmail\` CLI strips HTML email bodies, so security-code / verification emails (which are HTML-only) often show an empty body in the CLI output. When you need a code from an HTML email the CLI won't render:
1. Open a new tab in the controlled browser: \`browser_tabs\` action=new, url=\`https://mail.google.com/mail/u/0/#search/from:<sender>+subject:<text>\`
2. \`browser_snapshot\` the Gmail list — the email preview/snippet usually contains the code in plain text.
3. If the snippet is truncated, click the email row to open it and snapshot again.
4. Switch back to the application tab (\`browser_tabs\` action=select, index=N) and enter the code.

If neither path is available, call \`request_manual_verification\` and ask the user to paste the OTP/link or confirm completion. Never require Gmail, gcloud, or a particular email provider.

**Workspace:** ${WORKSPACE}

### Before every application
1. Read \`profile.md\` for the applicant's identity, work history, Q&A bank, and form-fill rules.
2. Read \`state.json\` to check for in-progress applications and the ethics acknowledgment gate.

### Resume & address matching
- **Resume:** call \`match_resume\` — it returns the absolute \`resume_path\`. If \`profile.md\`'s \`## Resume\` section names a \`Resume path\`, that one file is used for every application; otherwise the path is \`resumes/<resume_key>.pdf\`, falling back to \`resumes/default.pdf\`. If the resolved file does not exist, **stop and ask**.
- **Address:** location matching and address rules live in \`profile.md\`. \`match_resume\` also resolves \`address_city_key\` and any address already persisted for it.
- If \`state.json.addresses[<address_city_key>]\` is missing, ask the user for their truthful address, then call \`generate_address\` with exactly that address to persist it. Never fabricate an address.
- Resume paths are ABSOLUTE (required for browser file upload).

### Application workflow
1. Read the queue file (\`jobs/queue/<slug>.md\`). Parse frontmatter: url, company, title, location.
2. Use \`match_resume\` to pick resume + address city key.
3. Resolve address from \`state.json.addresses\` (ask for truthful input and persist it if missing).
4. Create/update the application entry in \`state.json\` with status \`in_progress\` and \`location_raw\` from the posting (use \`location_raw\`, not \`location\`; the schema accepts \`location\` only as an ignored alias for sessions resumed under older prompts).
5. Automatic submission must be acknowledged once (\`acknowledged_policy: ${AUTO_SUBMIT_POLICY_VERSION}\`). If \`read_application_state\` shows it missing, stop and tell the user to acknowledge in Setup or run \`/acknowledge\`. You cannot record it yourself.
6. Navigate to the job URL via Playwright MCP. Snapshot. Fill forms.
7. For file uploads, pass the absolute PDF path.
8. For free-text > 50 chars, type slowly (per-key) to reduce bot-detection signal.
9. Multi-step flows: loop snapshot → fill → next until submit appears.
10. **Submit automatically.** The user enabled automatic submission at setup, so do not ask before submitting. Submit only when the form is complete, valid and truthful per profile.md. Take a confirmation screenshot.
11. After submit, check for confirmation with an available email integration. If none is available, ask the user through \`request_manual_verification\`; do not treat missing email access as proof of failure.
12. Update \`state.json\` via \`update_application_state\`: status \`submitted\`, \`confirmation_source\` (\`greenhouse_submit_script\` | \`greenhouse_otp_script\` | \`page\` | \`email\` | \`user\`), \`confirmation_evidence\` (at least 10 characters quoting what you observed), \`screenshot\` under \`screenshots/\` or \`screenshot_error\`, and \`verification_email_id\` when known. Rolebound records \`submitted_at\` itself — do not send it. Then call \`complete_application\` with the application slug to move the queue file to \`jobs/applied/<slug>.md\`.

### Submission guard
A blocked tool call (submission guard) means stop and report the reason. Never retry the same action through another tool, \`bash\`, or a new process. When the user clicks Stop or removes the queue item being applied to, stop immediately — do not issue further browser, submit, or paid tool calls for that application.

### Greenhouse verification codes (email OTP)
Greenhouse job boards often require an 8-character email verification code before final submit. Flow:
1. Click \`Submit application\`. The form swaps in a "Security code" group with 8 separate one-char textboxes and a \`Submit application\` button that stays disabled until all 8 chars are filled.
2. The code is emailed from \`no-reply@us.greenhouse-mail.io\`. Use an available email integration, or call \`request_manual_verification({kind:"otp", ...})\` so the user can paste it.
3. Enter the code by typing the full 8-char string into the FIRST textbox ref with \`browser_type\` and \`slowly: true\` (\`pressSequentially\`). The OTP inputs auto-advance, so one \`browser_type\` call on the first box fills all 8. Do NOT try to fill each box individually.
4. Once all 8 boxes are populated the \`Submit application\` button enables. Click it.

${solver ? captchaWorkflowPrompt(solver.label) : ""}
### Stop and ask triggers
${solver
  ? `- **CAPTCHA the solver could not clear** — \`solve_captcha\` answered \`ok: false\`, or the page still rejected the form after the token was injected and submit was retried once. Set status \`blocked\` with \`block_reason: "captcha_solver_failed: <code>: <error>"\` and hand the browser back to the user. Never try to solve an image puzzle yourself.`
  : `- **CAPTCHA of any kind** — call \`request_manual_verification({kind:"captcha", ...})\`, hand the browser to the user, and resume only after they confirm completion. Never solve an image puzzle yourself.`}
- SSO login wall with no stored session
- Account creation required with no stored credentials (\`credentials.json\`)
- Required field not covered by \`profile.md\`
- Ambiguous free-text that risks misrepresentation
- Payment / ID upload / SSN / background check request
- Coding test / video interview / assessment embedded in application
- Anti-bot interstitial ("verifying you're human" delay > 10s)
- A city with no row in profile.md's address-rules table, where Remote is inappropriate
- Any page state you cannot confidently parse from the snapshot

### Status values
queued | in_progress | paused_for_user | submitted | aborted | blocked | failed

### Key files
- \`profile.md\` — source of truth for all form fills, and for the resume/city rules the tools read
- \`state.json\` — application tracking + address persistence
- \`credentials.json\` — ATS login credentials (plaintext, gitignored)
- \`jobs/queue/<slug>.md\` — pending postings
- \`jobs/applied/<slug>.md\` — completed postings
- \`resumes/\` — resume PDFs (\`default.pdf\` at minimum)
- \`screenshots/<slug>-confirmation.png\` — submit confirmation screenshots
`;

    const instructions = await readInstructions(WORKSPACE);
    let standingPrompt = "";
    if (process.env.PI_JOBS_RUN_KIND === "chat") {
      standingPrompt += formatChatInstructionsBlock(instructions.chat);
      standingPrompt += formatChatReferenceInstructions(instructions);
    } else if (!["gather", "score", "status"].includes(process.env.PI_JOBS_RUN_KIND ?? "")) {
      // Applying rules belong to application runs (and interactive pi), not discovery or scoring.
      standingPrompt += formatApplyingInstructionsBlock(instructions.applying);
    }
    const chatPrompt = process.env.PI_JOBS_RUN_KIND === "chat"
      ? "\n\n## Rolebound chat\nYou are Rolebound’s assistant inside a chat UI. Be brief and act through tools. When a resume is attached, call resume_extract_text, then write its facts into profile.md with profile_update_section. Ask only for facts the resume cannot supply: work authorization, target locations, salary, and truthful address. Never invent facts. Use the sanctioned workspace tools to edit the profile, queue, and resumes. When the user states a standing rule about how to apply, how to pick or score jobs, or how to talk, save it with instructions_update (append) and say it was saved under Agent instructions in the workspace. To apply to a job, call start_application (optional slug for a specific queue item) and end your turn — do not drive the browser or fill application forms in chat."
      : "";
    return { systemPrompt: event.systemPrompt + "\n\n" + prompt + standingPrompt + chatPrompt };
  });

  // ── Custom tools ──

  pi.registerTool({
    name: "list_queued_jobs",
    label: "List Queued Jobs",
    description: "List all job postings waiting in jobs/queue/",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const queueDir = wsPath("jobs", "queue");
      try {
        const files = await fs.readdir(queueDir);
        const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
        const jobs: Array<{ slug: string; path: string }> = mdFiles.map((f) => ({
          slug: f.replace(".md", ""),
          path: `${queueDir}/${f}`,
        }));
        return {
          content: [{ type: "text", text: `Queued jobs (${jobs.length}):\n${jobs.map((j) => `- ${j.slug}: ${j.path}`).join("\n")}` }],
          details: { jobs },
        };
      } catch {
        return { content: [{ type: "text", text: "No jobs/queue/ directory found." }], details: { jobs: [] } };
      }
    },
  });

  pi.registerTool({
    name: "match_resume",
    label: "Match Resume",
    description:
      "Given a job location string, return the matching resume key, absolute resume path, address city key, and persisted address " +
      "(or null if remote/default). Rules come from profile.md — resume region rules, city → address rules, and an optional single " +
      "resume path override.",
    parameters: Type.Object({
      location: Type.String({ description: "Job location string, e.g. 'Seattle, WA' or 'Remote'" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const match = await matchResume(params.location);
      const state = await readApplicationState();
      const addresses = (state.addresses as Record<string, { street: string; city: string; state: string; zip: string }>) || {};
      match.address = addresses[match.address_city_key] || null;
      const resumeMissing = !(await fileExists(match.resume_path));
      const text = resumeMissing
        ? `${JSON.stringify(match, null, 2)}\n\nWARNING: ${match.resume_path} does not exist. Stop and ask the user for a resume.`
        : JSON.stringify(match, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { ...match, resume_exists: !resumeMissing },
      };
    },
  });

  pi.registerTool({
    name: "read_application_state",
    label: "Read Application State",
    description: "Read state.json (applications, addresses, acknowledgment state).",
    parameters: Type.Object({}),
    async execute() {
      const state = await readApplicationStateStrict();
      if ("error" in state) {
        return {
          content: [{ type: "text", text: stateCorruptMessage(state.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        details: state,
      };
    },
  });

  pi.registerTool({
    name: "update_application_state",
    label: "Update Application State",
    description: "Create or update a single application entry in state.json. Merges into existing entries by slug.",
    parameters: UPDATE_APPLICATION_STATE_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.queue_file !== undefined && !isValidQueueFileRecord(params.queue_file)) {
        return {
          content: [
            {
              type: "text",
              text: `queue_file must be jobs/queue/<name>.md or jobs/applied/<name>.md; got ${params.queue_file}`,
            },
          ],
          isError: true,
        };
      }
      const state = await readApplicationState();
      const apps = (state.applications as Array<Record<string, unknown>>) || [];
      const prior = apps.find((a) => a.slug === params.slug);

      const reopening =
        prior?.status === "submitted" && params.status !== undefined && params.status !== "submitted";
      let reopenApproval: { submitted_at: string | null } | undefined;
      if (reopening) {
        if (params.override_submitted !== true) {
          reopenApproval = undefined;
        } else {
          const runDir = process.env.PI_JOBS_RUN_DIR?.trim();
          if (runStopMarkerExists(runDir) || !ctx.hasUI) {
            return {
              content: [{ type: "text", text: "Reopening needs the user's confirmation (override_submitted)." }],
              isError: true,
            };
          }
          const submittedLabel =
            typeof prior.submitted_at === "string" ? prior.submitted_at : "unknown date";
          const company = String(prior.company ?? params.slug);
          const title = String(prior.title ?? params.slug);
          const confirmed = await ctx.ui.confirm(
            `Reopen ${company} — ${title}?`,
            `Its status is submitted (${submittedLabel}). Reopening allows Rolebound to submit it again.`,
            { signal },
          );
          if (!confirmed) {
            return {
              content: [{ type: "text", text: "Reopening needs the user's confirmation (override_submitted)." }],
              isError: true,
            };
          }
          reopenApproval = { submitted_at: (prior.submitted_at as string | undefined) ?? null };
        }
      }

      const evidence = await validateSubmittedTransition(WORKSPACE, params.slug, prior, params);
      if (!evidence.ok) {
        return { content: [{ type: "text", text: evidence.message }], isError: true };
      }

      const result = await mutateApplicationState(
        { slug: params.slug, status: params.status, reopenApproval },
        (app, existing) => {
          const transitioningToSubmitted =
            params.status === "submitted" && existing?.status !== "submitted";
          if (params.url !== undefined) app.url = params.url;
          if (params.company !== undefined) app.company = params.company;
          if (params.title !== undefined) app.title = params.title;
          if (params.location_raw !== undefined) app.location_raw = params.location_raw;
          if (params.location !== undefined && params.location_raw === undefined) {
            app.location_raw = params.location;
          }
          if (params.resume_key !== undefined) app.resume_key = params.resume_key;
          if (params.address_city_key !== undefined) app.address_city_key = params.address_city_key;
          if (params.resume !== undefined) app.resume = params.resume;
          if (params.address !== undefined) app.address = params.address;
          if (params.screenshot !== undefined) app.screenshot = params.screenshot;
          if (params.verification_email_id !== undefined) app.verification_email_id = params.verification_email_id;
          if (params.confirmation_source !== undefined) app.confirmation_source = params.confirmation_source;
          if (params.confirmation_evidence !== undefined) {
            app.confirmation_evidence = params.confirmation_evidence;
          }
          if (params.screenshot_error !== undefined) app.screenshot_error = params.screenshot_error;
          if (transitioningToSubmitted) {
            app.submitted_at = evidence.submitted_at;
          }
          if (params.abort_reason !== undefined) app.abort_reason = params.abort_reason;
          if (params.block_reason !== undefined) app.block_reason = params.block_reason;
          if (params.queue_file !== undefined) app.queue_file = params.queue_file;
          const attempt = resolveAttempt(params);
          if (attempt) {
            const attempts = (app.attempts as Array<Record<string, unknown>>) || [];
            attempts.push(attempt);
            app.attempts = attempts;
          }
          if (!app.attempts) app.attempts = [];
        },
      );
      if (!result.ok) {
        const err = result.error;
        const message =
          typeof err === "object" && err !== null && "code" in err
            ? String(err.message)
            : err instanceof WorkspaceFileError
              ? stateCorruptMessage(err)
              : String(err);
        return { content: [{ type: "text", text: message }], isError: true };
      }

      let extra = "";
      if (reopening && reopenApproval) {
        const obsErr = await unlinkObservation(WORKSPACE, params.slug);
        if (obsErr) extra = `\nWarning: could not delete observation file: ${obsErr}`;
      }

      await regenerateAppliedTracker().catch(() => {});
      return {
        content: [{ type: "text", text: `Updated application state for ${params.slug}.${extra}` }],
        details: { ...result.app, card: "application" },
      };
    },
  });

  pi.registerTool({
    name: "complete_application",
    label: "Complete Application",
    description:
      "After status is submitted, move the queue job file to jobs/applied/<slug>.md and repoint queue_file in state.json.",
    parameters: Type.Object({
      slug: Type.String({ description: "Application slug (state.json entry)" }),
    }),
    async execute(_toolCallId, params) {
      const result = await completeApplication(params.slug);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true, details: result };
      }
      return {
        content: [{ type: "text", text: `Completed application ${params.slug}; queue_file is ${result.queue_file}.` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "generate_address",
    label: "Generate Address",
    description:
      "Persists a user-supplied address for a city key. With no address, returns an ask-user instruction. Never fabricates address data.",
    parameters: Type.Object({
      city_key: Type.String({ description: "Address city key from match_resume, e.g. 'seattle'" }),
      address: Type.Optional(Type.Object({ street: Type.String(), city: Type.String(), state: Type.String(), zip: Type.String() })),
    }),
    async execute(_toolCallId, params) {
      const state = await readApplicationStateStrict();
      if ("error" in state) {
        return { content: [{ type: "text", text: stateCorruptMessage(state.error) }], isError: true };
      }
      const addresses = (state.addresses as Record<string, { street: string; city: string; state: string; zip: string }>) || {};
      if (addresses[params.city_key]) {
        return {
          content: [{ type: "text", text: `Address already exists for ${params.city_key}: ${JSON.stringify(addresses[params.city_key])}` }],
          details: addresses[params.city_key],
        };
      }
      const { address, reason } = await generateAddress(params.city_key, params.address);
      if (!address) {
        return {
          content: [{ type: "text", text: `No address generated for city_key='${params.city_key}'. ${reason ?? ""}`.trim() }],
          details: { address: null, reason },
        };
      }
      const wrote = await mutateAddresses((addrs) => {
        addrs[params.city_key] = address;
        return addrs;
      });
      if (!wrote.ok && wrote.error instanceof WorkspaceFileError) {
        return { content: [{ type: "text", text: stateCorruptMessage(wrote.error) }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Persisted user-provided address for ${params.city_key}: ${JSON.stringify(address)}` }],
        details: address,
      };
    },
  });

  pi.registerTool({
    name: "request_manual_verification",
    label: "Request Manual Verification",
    description: "Pause for a user-provided OTP/link or for confirmation that a CAPTCHA was completed in the controlled browser.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("otp"), Type.Literal("link"), Type.Literal("captcha")]),
      message: Type.String({ description: "What the user should retrieve or complete" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.kind === "captcha") {
        const confirmed = await ctx.ui.confirm("Manual CAPTCHA required", `${params.message}\n\nComplete it in the controlled browser, then confirm to resume.`);
        return { content: [{ type: "text", text: confirmed ? "User confirmed manual CAPTCHA completion; re-snapshot before continuing." : "Manual CAPTCHA was not completed; keep the application paused." }], details: { kind: params.kind, confirmed } };
      }
      const value = await ctx.ui.input(params.kind === "otp" ? "Enter verification code" : "Enter verification link", params.message);
      if (!value) {
        return {
          content: [{ type: "text", text: `No ${params.kind} was supplied; keep the application paused.` }],
          details: { kind: params.kind, value: null },
        };
      }
      const label = params.kind === "otp" ? "Verification code" : "Verification link";
      return {
        content: [
          {
            type: "text",
            text: `${label}: ${value} — use it only for the current verification step.`,
          },
        ],
        details: { kind: params.kind, value },
      };
    },
  });

  pi.registerTool({
    name: "solve_captcha",
    label: "Solve CAPTCHA",
    description:
      "Solve the CAPTCHA on the current page through the paid provider configured in settings.json " +
      "(or the CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY env var). At most " +
      `${MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION} paid provider tasks per application (persisted in state.json) and a rolling 24-hour workspace cap from settings. ` +
      "Detect the widget first with the browser_evaluate script from the system prompt, then pass its kind, sitekey and page_url here. " +
      "On success returns {ok: true, token, task_type, provider, elapsed_ms, inject_function} — pass inject_function unchanged to browser_evaluate's function. " +
      "On {ok: false, code, error}: for disabled, unsupported_kind or budget_exhausted stop and ask — do not retry.",
    parameters: Type.Object({
      slug: Type.String({ description: "Application slug, for the per-application solve budget" }),
      kind: Type.Union([
        Type.Literal("hcaptcha"),
        Type.Literal("recaptcha_v2"),
        Type.Literal("recaptcha_v3"),
        Type.Literal("turnstile"),
      ]),
      sitekey: Type.String({ description: "The widget's sitekey from the detection script" }),
      page_url: Type.String({ description: "window.location.href of the page showing the widget" }),
      invisible: Type.Optional(Type.Boolean({ description: "Widget rendered with size=invisible" })),
      rqdata: Type.Optional(Type.String({ description: "hCaptcha Enterprise rqdata, when the page exposes it" })),
      action: Type.Optional(Type.String({ description: "reCAPTCHA v3 action / Turnstile action" })),
      cdata: Type.Optional(Type.String({ description: "Turnstile cData" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!isSafeSlug(params.slug)) {
        return {
          isError: true,
          content: [{ type: "text", text: `STATE_INVALID: invalid tool slug ${JSON.stringify(params.slug)}` }],
        };
      }
      const settings = await readCaptcha();
      let budgetError: string | undefined;
      const result = await solveCaptcha(
        settings,
        {
          kind: params.kind as CaptchaKind,
          sitekey: params.sitekey,
          page_url: params.page_url,
          extras: { invisible: params.invisible, rqdata: params.rqdata, action: params.action, cdata: params.cdata },
        },
        {
          getBudgetError: () => budgetError,
          beforeTask: async () => {
            const app = await reserveApplicationPaidCaptchaTask(params.slug);
            if (!app.ok) {
              budgetError = app.error;
              return false;
            }
            const provider = settings.provider === "off" ? "off" : settings.provider;
            const daily = await reservePaidTask(WORKSPACE, Date.now(), {
              slug: params.slug,
              provider,
              settingsPath: SETTINGS_FILE,
            });
            if (!daily.ok) {
              budgetError = daily.error;
              await mutateApplicationState({ slug: params.slug }, (app) => {
                const n = typeof app.captcha_paid_tasks === "number" ? app.captcha_paid_tasks : 0;
                app.captcha_paid_tasks = Math.max(0, n - 1);
              });
              return false;
            }
            return true;
          },
        },
      );
      if (!result.ok) {
        const stopCodes = new Set(["disabled", "unsupported_kind", "budget_exhausted"]);
        const blocked_instruction = stopCodes.has(result.code) ? CAPTCHA_BLOCKED_INSTRUCTION : undefined;
        const confirmed = await ctx.ui.confirm(
          "Manual CAPTCHA recovery",
          `${result.error}\n\nComplete the challenge in the controlled browser, then confirm to resume.`,
          { signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ ...result, manual_completed: confirmed, blocked_instruction }) }],
          details: { ...result, manual_completed: confirmed, blocked_instruction },
        };
      }
      const inject_function = buildCaptchaInjectFunction(result.token, params.kind);
      const payload = { ...result, inject_function };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    },
  });

  pi.registerTool({
    name: "check_gmail_confirmations",
    label: "Check Gmail Confirmations",
    description: "Search Gmail for application confirmation or receipt emails from a company.",
    parameters: Type.Object({
      company: Type.String({ description: "Company name, e.g. 'Acme'" }),
      since_days: Type.Optional(Type.Number({ description: "Search emails from last N days (default 7)" })),
    }),
    async execute(_toolCallId, params) {
      const { execSync } = await import("node:child_process");
      const days = params.since_days ?? 7;
      const after = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
      const companyLower = params.company.toLowerCase();

      const queries = [
        `from:${companyLower} after:${after}`,
        `from:${companyLower} subject:application after:${after}`,
        `from:${companyLower} subject:received after:${after}`,
      ];

      const results: Array<{ query: string; output: string; error?: string }> = [];
      for (const query of queries) {
        try {
          const output = execSync(`gmail search '${query}'`, { encoding: "utf-8", timeout: 15000 });
          results.push({ query, output: output.trim() || "(no results)" });
        } catch (err: any) {
          results.push({ query, output: "", error: err.message });
        }
      }

      const text = results.map((r) => `Query: ${r.query}\n${r.error ? `Error: ${r.error}` : r.output}`).join("\n---\n");
      return {
        content: [{ type: "text", text }],
        details: { results, company: params.company, after },
      };
    },
  });

  // ── Commands ──

  pi.registerCommand("apply-next", {
    description: "Apply to the next queued job posting",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job applier extension is only active in the workspace root.", "warning");
        return;
      }
      const queueDir = wsPath("jobs", "queue");
      const files = await fs.readdir(queueDir).catch(() => [] as string[]);
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
      if (mdFiles.length === 0) {
        ctx.ui.notify("No queued jobs found.", "info");
        return;
      }
      const state = await readApplicationStateStrict();
      if ("error" in state) {
        ctx.ui.notify(stateCorruptMessage(state.error), "warning");
        return;
      }
      let next: string | null = null;
      for (const file of mdFiles) {
        const skip = await shouldSkipQueueFileForApply(file, state);
        if (!skip.skip) {
          next = file;
          break;
        }
      }
      if (!next) {
        ctx.ui.notify(
          "No new queued jobs (remaining queue entries match submitted applications). Run npm run doctor -- --repair if this looks wrong.",
          "warning",
        );
        return;
      }
      const { slug } = resolveQueueJob(WORKSPACE, next);
      const { applyReadinessBlocker } = await import("../../ui/server/runReadiness");
      const readiness = await applyReadinessBlocker(WORKSPACE, { includeConnection: false, slug });
      if (readiness) {
        ctx.ui.notify(`${readiness.code}: ${readiness.message}`, "warning");
        return;
      }
      const { evaluateApplyRunGate } = await import("./lib/submission-policy");
      const gate = await evaluateApplyRunGate(WORKSPACE, slug);
      if (!gate.ok) {
        const wait =
          gate.code === "RATE_LIMITED" && gate.retryAfterMs
            ? ` Try again in about ${Math.ceil(gate.retryAfterMs / 60_000)} minutes.`
            : "";
        ctx.ui.notify(`${gate.code}: ${gate.message}${wait}`, "warning");
        return;
      }
      ctx.ui.notify(`Queueing application for ${slug}...`, "info");
      pi.sendUserMessage(`Apply to the next queued job: ${slug} (file: jobs/queue/${next}); use slug \`${slug}\` in tool calls`, { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("status", {
    description: "Show current job application status",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job applier extension is only active in the workspace root.", "warning");
        return;
      }
      const state = await readApplicationState();
      const apps = (state.applications as Array<Record<string, unknown>>) || [];
      const queued = await fs.readdir(wsPath("jobs", "queue")).catch(() => [] as string[]);
      const queuedCount = queued.filter((f) => f.endsWith(".md")).length;
      const profile = await loadProfileOrEmpty();
      const captcha = await readCaptcha();
      const summary = [
        `Queued: ${queuedCount}`,
        `Total tracked: ${apps.length}`,
        captchaStatusLine(captcha),
        ...apps.map((a) => `- ${a.slug}: ${a.status} (${a.company || "?"})`),
        ...profile.warnings.map((w) => `! ${w}`),
        ...captcha.warnings.map((w) => `! ${w}`),
      ].join("\n");
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("acknowledge", {
    description: "Acknowledge automatic submission (one-time)",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job applier extension is only active in the workspace root.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Acknowledgement needs the Rolebound UI — use Setup or Settings.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm("Automatic submission", AUTO_SUBMIT_DISCLOSURE_TEXT);
      if (!confirmed) return;
      const ack = await setAcknowledgedAt(AUTO_SUBMIT_POLICY_VERSION);
      if (!ack.ok && ack.error instanceof WorkspaceFileError) {
        ctx.ui.notify(stateCorruptMessage(ack.error), "warning");
        return;
      }
      ctx.ui.notify("Automatic submission acknowledged. You may now apply to jobs.", "info");
    },
  });

  pi.registerCommand("tracker", {
    description: "Regenerate APPLIED.md tracker from state.json",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job applier extension is only active in the workspace root.", "warning");
        return;
      }
      await regenerateAppliedTracker();
      ctx.ui.notify("APPLIED.md regenerated.", "info");
    },
  });

  // ── Session start notification ──
  pi.on("session_start", async (_event, ctx) => {
    if (isInWorkspace(ctx.cwd)) {
      ctx.ui.notify("Job Applier Agent loaded. Use /apply-next, /status, /acknowledge, or /tracker.", "info");
    }
  });
}
