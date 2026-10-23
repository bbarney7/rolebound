/**
 * Job Accounts Agent — Pi Extension
 *
 * Manages ATS accounts (Workday, iCIMS, SmartRecruiters, etc.) for the applier.
 * Many ATS platforms require per-company accounts before you can apply.
 * This extension handles:
 *
 * - Looking up existing credentials by host
 * - Generating strong passwords that meet typical ATS requirements
 * - Creating accounts via browser automation (Playwright MCP)
 * - Logging in with stored credentials
 * - Resetting passwords when login fails
 * - Tracking all accounts to avoid duplicates
 *
 * Email strategy (addresses come from profile.md, never from this file):
 * - Primary:   <local>+<company>@<domain> built from the Identity email
 *              (+aliasing delivers to the same inbox)
 * - Fallback:  the Identity "Fallback email", used only if +aliasing is blocked
 *
 * Credentials are stored in credentials.json (plaintext, gitignored, local-only).
 * The applier calls these tools when it hits a login/signup wall.
 *
 * Provides:
 * - Tools: get_account, create_account, login_to_ats, reset_password,
 *          list_accounts, update_account
 * - System prompt injection with account management workflow
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { wsPath, isInWorkspace } from "./lib/workspace";
import { loadProfile } from "./lib/profile";
import { generatePassword } from "./lib/password";
import {
  corruptFileRecoveryMessage,
  findAccount,
  mutateAccounts,
  NO_CHANGE,
  readAccountsFile,
} from "./lib/accounts-store";
import { CredentialsShapeError } from "./lib/workspace-files";
import { WorkspaceFileError } from "./lib/durable-store";
import { WORKSPACE_FILES } from "./lib/workspace-files";

// ── Types ──

interface AccountEntry {
  username: string;
  password: string;
  email_used: string;
  ats: "workday" | "greenhouse" | "lever" | "ashby" | "icims" | "smartrecruiters" | "bamboohr" | "other";
  company: string;
  host: string;
  created_at: string;
  last_used_at: string;
  last_login_status?: "success" | "failed" | "pending";
  notes?: string;
}

type Credentials = Record<string, AccountEntry>;

// ── Helpers ──

function credentialsCorruptResult(err: WorkspaceFileError | CredentialsShapeError) {
  const file =
    err instanceof WorkspaceFileError
      ? err.file
      : wsPath(WORKSPACE_FILES.credentials);
  const message =
    err instanceof WorkspaceFileError && err.code === "CORRUPT"
      ? corruptFileRecoveryMessage(file)
      : `${path.basename(file)}: ${err.message}. ${corruptFileRecoveryMessage(file)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function readCredentialsStrict(): Promise<Credentials | { error: WorkspaceFileError | CredentialsShapeError }> {
  try {
    return (await readAccountsFile()) as Credentials;
  } catch (err) {
    if (err instanceof WorkspaceFileError || err instanceof CredentialsShapeError) {
      return { error: err };
    }
    throw err;
  }
}

/**
 * Extract the ATS host from a URL.
 * e.g., "https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/123/apply" → "acme.wd5.myworkdayjobs.com"
 */
function extractHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    // Fallback: extract between "https://" and the next "/"
    const m = url.match(/https?:\/\/([^/]+)/);
    return m ? m[1] : url;
  }
}

/**
 * Extract the company name from a Workday-style host.
 * e.g., "acme.wd5.myworkdayjobs.com" → "Acme"
 */
function companyFromHost(host: string): string {
  // Workday: <company>.wd<NUM>.myworkdayjobs.com
  const wd = host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com/);
  if (wd) return titleCase(wd[1]);

  // Greenhouse: boards.greenhouse.io/<company> → use the path
  // Ashby: jobs.ashbyhq.com/<company>
  // For other ATS, just use the first subdomain part
  const first = host.split(".")[0];
  if (first && first !== "www" && first !== "boards" && first !== "jobs") {
    return titleCase(first);
  }
  return host;
}

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => (w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Determine which email to use for a company, from profile.md's Identity
 * section. Primary is the Identity email with a `+<company>` alias so all ATS
 * mail lands in the same inbox; the fallback is the optional "Fallback email"
 * bullet, used only when a signup form rejects +aliasing.
 */
async function resolveEmail(
  company: string,
  useFallback: boolean,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const result = await loadProfile();
  if (!result.ok) return { ok: false, error: result.error };

  const { email, fallbackEmail } = result.profile.identity;
  if (useFallback) {
    if (!fallbackEmail) {
      return {
        ok: false,
        error:
          "profile.md has no `- **Fallback email:**` bullet in `## Identity`. " +
          "Add one, or ask the user which address to use for this signup.",
      };
    }
    return { ok: true, email: fallbackEmail };
  }

  if (!email) {
    return {
      ok: false,
      error: "profile.md has no `- **Email:**` bullet in `## Identity`. Add one before creating ATS accounts.",
    };
  }
  const at = email.lastIndexOf("@");
  if (at <= 0) return { ok: false, error: `The Identity email in profile.md is not a valid address: ${email}` };
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!slug) return { ok: true, email };
  return { ok: true, email: `${email.slice(0, at)}+${slug}${email.slice(at)}` };
}

// ── Extension ──

export default function jobAccountsExtension(pi: ExtensionAPI) {
  // ── System prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isInWorkspace(ctx.cwd)) return;

    const prompt = `## Job Accounts Agent

You are also an ATS account management agent. A third pi extension (\`job-accounts.ts\`) is loaded in this workspace alongside the job applier and gatherer. Its job is to manage accounts on ATS platforms that require login (Workday, iCIMS, SmartRecruiters, etc.) so the applier never gets stuck on a login wall.

**Use the registered account tools — do not manage credentials inline.** Call \`get_account\`, \`create_account\`, \`login_to_ats\`, \`reset_password\`, \`list_accounts\` as appropriate.

### When to use account tools

The applier hits a login/signup wall during \`/apply-next\` when:
1. The ATS page shows a "Sign In" or "Create Account" form instead of the application form
2. The URL contains \`/login\`, \`/signup\`, \`/register\`, or \`/auth\`
3. The page asks for email + password before showing application fields

### Account creation flow

1. **Check for existing account:** Call \`get_account({ host, company })\`. If an account exists, use \`login_to_ats\` to log in with stored credentials.
2. **If no account exists:** Call \`create_account\` to generate credentials and persist them. The tool returns \`{ username, password, email_used }\`. Then fill the signup form via Playwright.
3. **If login fails (stale password):** Call \`reset_password\` to initiate a password reset flow. Use an available email integration, or ask the user to paste the reset link/code through \`request_manual_verification\`.

### Email strategy

- **Primary:** the \`## Identity\` email from \`profile.md\`, +aliased per company (\`user+acme@example.com\`) so all ATS mail lands in the same inbox.
- **Fallback:** the \`## Identity\` "Fallback email" from \`profile.md\` — use ONLY if +aliasing is blocked by the ATS signup form.
- The \`create_account\` tool builds the +aliased email automatically. If the form rejects it, call it again with \`use_fallback_email=true\` and update the account entry. If \`profile.md\` declares no fallback, stop and ask the user.

### Password generation

The \`create_account\` tool generates a strong 14-char password with uppercase, lowercase, digits, and special chars (\`!@#$%^&*\`). This meets virtually all ATS password requirements.

### Credential storage

Credentials are stored in \`credentials.json\` (plaintext, gitignored, local-only). Keyed by ATS host (e.g., \`acme.wd5.myworkdayjobs.com\`). Schema:

\`\`\`json
{
  "<host>": {
    "username": "applicant+acme@example.com",
    "password": "xY3!kP9mQr$2wN",
    "email_used": "applicant+acme@example.com",
    "ats": "workday",
    "company": "Acme",
    "host": "acme.wd5.myworkdayjobs.com",
    "created_at": "ISO",
    "last_used_at": "ISO",
    "last_login_status": "success | failed | pending"
  }
}
\`\`\`

### Workday-specific notes

Workday signup flow:
1. Navigate to the job application URL
2. Click "Sign In" → "Create Account" (or "Register")
3. Fill: First Name, Last Name, Email, Password
4. Submit → use an available email integration for verification, or ask the user for the link/code
5. Return to application URL and continue

Workday password requirements (typical):
- 8+ characters (our generated 14-char passwords always pass)
- At least one uppercase, one lowercase, one number, one special char
- Some Workday instances reject \`$\` or \`\\\` — if so, regenerate without those chars

### Do NOT
- Do not create duplicate accounts for the same company. Always check \`get_account\` first.
- Use only truthful address data the user supplied and saved. Never fabricate an address.
- Do not store credentials anywhere except \`credentials.json\`.
- Do not skip email verification if the ATS requires it. Use an available integration or ask the user for the link/code.
`;

    return { systemPrompt: event.systemPrompt + "\n\n" + prompt };
  });

  // ── Tools ──

  pi.registerTool({
    name: "get_account",
    label: "Get ATS Account",
    description:
      "Look up stored credentials for an ATS host and/or company. Returns the account entry if found, or null. " +
      "Always call this before create_account to avoid duplicates. " +
      "Matches by host first, then by company name (case-insensitive).",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "ATS host (e.g., 'acme.wd5.myworkdayjobs.com'). Extracted from the application URL." })),
      company: Type.Optional(Type.String({ description: "Company name (e.g., 'Acme'). Used as fallback if host doesn't match." })),
      url: Type.Optional(Type.String({ description: "Full application URL — host will be extracted automatically if 'host' is not provided." })),
    }),
    async execute(_toolCallId, params) {
      const host = params.host || (params.url ? extractHost(params.url) : "");
      const company = params.company || (host ? companyFromHost(host) : "Unknown");

      if (!host && !company) {
        return { content: [{ type: "text", text: "Either host or url must be provided." }], isError: true };
      }

      const creds = await readCredentialsStrict();
      if ("error" in creds) return credentialsCorruptResult(creds.error);

      const existing = findAccount(creds, host, company);
      if (!existing) {
        return {
          content: [{ type: "text", text: `No account found for ${company} (${host || "unknown host"}). Use create_account to make one.` }],
          details: { found: false, host, company },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Account found for ${existing.entry.company} (${existing.key}):\n` +
              `  Username: ${existing.entry.username}\n` +
              `  Password: ${existing.entry.password}\n` +
              `  ATS: ${existing.entry.ats}\n` +
              `  Last login: ${existing.entry.last_login_status || "unknown"}\n` +
              `  Created: ${existing.entry.created_at}`,
          },
        ],
        details: { found: true, key: existing.key, entry: existing.entry },
      };
    },
  });

  pi.registerTool({
    name: "create_account",
    label: "Create ATS Account",
    description:
      "Generate and persist credentials for a new ATS account. Does NOT fill the signup form — the agent must do that via Playwright. " +
      "Returns { username, password, email_used, host, company }. " +
      "ALWAYS call get_account first to check for duplicates. " +
      "Email strategy: primary = the profile.md Identity email, +aliased per company. " +
      "If the ATS rejects +aliasing, call this again with use_fallback_email=true.",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "ATS host (e.g., 'acme.wd5.myworkdayjobs.com')" })),
      company: Type.Optional(Type.String({ description: "Company name" })),
      url: Type.Optional(Type.String({ description: "Full URL — host extracted automatically if 'host' not provided" })),
      ats: Type.Optional(Type.String({ description: "ATS platform type: 'workday', 'icims', 'smartrecruiters', 'greenhouse', 'lever', 'ashby', 'bamboohr', 'other'. Defaults to 'workday' if host matches *.myworkdayjobs.com." })),
      use_fallback_email: Type.Optional(Type.Boolean({ description: "If true, use the profile.md fallback email instead of +aliasing. Use when the ATS rejects +aliasing." })),
    }),
    async execute(_toolCallId, params) {
      const host = params.host || (params.url ? extractHost(params.url) : "");
      if (!host) {
        return { content: [{ type: "text", text: "Could not determine host. Provide 'host' or 'url'." }], isError: true };
      }

      const company = params.company || companyFromHost(host);
      const atsType = (params.ats || (host.includes("myworkdayjobs.com") ? "workday" : "other")) as AccountEntry["ats"];

      // Generate credentials
      const password = generatePassword();
      const resolved = await resolveEmail(company, params.use_fallback_email === true);
      if (!resolved.ok) {
        return { content: [{ type: "text", text: resolved.error }], isError: true };
      }
      const email = resolved.email;

      const now = new Date().toISOString();
      const entry: AccountEntry = {
        username: email,
        password,
        email_used: email,
        ats: atsType,
        company,
        host,
        created_at: now,
        last_used_at: now,
        last_login_status: "pending",
        notes: `Auto-generated by job-accounts extension. Email: ${params.use_fallback_email ? "profile fallback" : "+aliased"}.`,
      };

      let existing: { key: string; entry: AccountEntry } | null = null;
      const wrote = await mutateAccounts((creds) => {
        const hit = findAccount(creds as Credentials, host, company);
        if (hit) {
          existing = { key: hit.key, entry: hit.entry as AccountEntry };
          return NO_CHANGE;
        }
        creds[host] = entry;
        return creds;
      });
      if (!wrote.ok) return credentialsCorruptResult(wrote.error);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: `Account already exists for ${company} (${existing.key}). Use login_to_ats with the stored credentials:\n` +
                `  Username: ${existing.entry.username}\n` +
                `  Password: ${existing.entry.password}`,
            },
          ],
          details: { created: false, already_exists: true, key: existing.key, entry: existing.entry },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Created account entry for ${company} (${host}):\n` +
              `  Username/Email: ${email}\n` +
              `  Password: ${password}\n` +
              `  ATS: ${atsType}\n\n` +
              `Now fill the signup form via Playwright with these credentials. After signup, call login_to_ats to mark login status.`,
          },
        ],
        details: { created: true, key: host, entry },
      };
    },
  });

  pi.registerTool({
    name: "login_to_ats",
    label: "Login to ATS",
    description:
      "Mark a login attempt for an ATS account. Updates last_used_at and last_login_status in credentials.json. " +
      "Call this AFTER attempting to log in via Playwright — pass success=true if login worked, false if it failed. " +
      "This does NOT perform the login itself — the agent fills the login form via Playwright, then calls this to record the result.",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "ATS host" })),
      url: Type.Optional(Type.String({ description: "Full URL — host extracted if 'host' not provided" })),
      company: Type.Optional(Type.String({ description: "Company name (fallback if host not found)" })),
      success: Type.Boolean({ description: "Whether the login attempt succeeded" }),
      notes: Type.Optional(Type.String({ description: "Optional notes about the login attempt" })),
    }),
    async execute(_toolCallId, params) {
      const host = params.host || (params.url ? extractHost(params.url) : "");
      const company = params.company || (host ? companyFromHost(host) : "");

      let resultKey = "";
      let resultEntry: AccountEntry | null = null;
      const wrote = await mutateAccounts((creds) => {
        const found = findAccount(creds as Credentials, host, company);
        const key = found?.key ?? (host && Object.hasOwn(creds, host) ? host : "");
        if (!key || !creds[key]) return NO_CHANGE;
        creds[key].last_used_at = new Date().toISOString();
        creds[key].last_login_status = params.success ? "success" : "failed";
        if (params.notes) {
          creds[key].notes = (creds[key].notes || "") + ` | ${params.notes}`;
        }
        resultKey = key;
        resultEntry = creds[key] as AccountEntry;
        return creds;
      });
      if (!wrote.ok) return credentialsCorruptResult(wrote.error);
      if (!resultEntry) {
        return {
          content: [{ type: "text", text: `No account found for ${company} (${host}). Call create_account first.` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Updated login status for ${resultEntry.company} (${resultKey}): ${resultEntry.last_login_status}`,
          },
        ],
        details: { key: resultKey, entry: resultEntry },
      };
    },
  });

  pi.registerTool({
    name: "reset_password",
    label: "Reset ATS Password",
    description:
      "Generate a new password and update the stored credentials for an ATS account. " +
      "Call this when a login fails and you want to initiate a password reset flow. " +
      "Returns the new password. The agent must then: 1) click 'Forgot Password' on the ATS, 2) enter the email, 3) use an available email integration or ask the user for the reset link/code, 4) use the new password when setting the new password. " +
      "If the ATS sends a reset link via email, click it and enter the new password on the reset page.",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "ATS host" })),
      url: Type.Optional(Type.String({ description: "Full URL — host extracted if 'host' not provided" })),
      company: Type.Optional(Type.String({ description: "Company name (fallback)" })),
    }),
    async execute(_toolCallId, params) {
      const host = params.host || (params.url ? extractHost(params.url) : "");
      const company = params.company || (host ? companyFromHost(host) : "");

      const newPassword = generatePassword();
      let resultKey = "";
      let emailUsed = "";
      let companyName = "";
      const wrote = await mutateAccounts((creds) => {
        const found = findAccount(creds as Credentials, host, company);
        const key = found?.key ?? (host && Object.hasOwn(creds, host) ? host : "");
        if (!key || !creds[key]) return NO_CHANGE;
        const oldPassword = creds[key].password;
        creds[key].password = newPassword;
        creds[key].last_used_at = new Date().toISOString();
        creds[key].last_login_status = "pending";
        creds[key].notes = (creds[key].notes || "") + ` | Password reset. Old: ${oldPassword.slice(0, 3)}***`;
        resultKey = key;
        emailUsed = creds[key].email_used;
        companyName = creds[key].company;
        return creds;
      });
      if (!wrote.ok) return credentialsCorruptResult(wrote.error);
      if (!resultKey) {
        return {
          content: [{ type: "text", text: `No account found for ${company} (${host}). Call create_account first.` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Password reset for ${companyName} (${resultKey}).\n` +
              `  Email: ${emailUsed}\n` +
              `  New password: ${newPassword}\n\n` +
              `Now: 1) Click 'Forgot Password' on the ATS, 2) Enter the email above, 3) retrieve the reset link with an available integration or ask the user, 4) Enter the new password on the reset page.`,
          },
        ],
        details: { key: resultKey, email: emailUsed, new_password: newPassword },
      };
    },
  });

  pi.registerTool({
    name: "list_accounts",
    label: "List All Accounts",
    description: "List all stored ATS accounts from credentials.json with their login status and last-used time.",
    parameters: Type.Object({}),
    async execute() {
      const creds = await readCredentialsStrict();
      if ("error" in creds) return credentialsCorruptResult(creds.error);
      const entries = Object.entries(creds);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No accounts stored in credentials.json." }] };
      }
      const lines = entries
        .sort(([_a, a], [_b, b]) => (b.last_used_at || "").localeCompare(a.last_used_at || ""))
        .map(([key, e]) => {
          const status = e.last_login_status ? ` [${e.last_login_status}]` : "";
          return `- ${e.company} (${e.ats})${status} — ${e.email_used} | ${key}`;
        });
      return {
        content: [{ type: "text", text: `Accounts (${entries.length}):\n${lines.join("\n")}` }],
        details: { count: entries.length, accounts: creds },
      };
    },
  });

  pi.registerTool({
    name: "update_account",
    label: "Update Account Entry",
    description:
      "Manually update a field in a stored ATS account entry. Useful for correcting the email, ATS type, or notes after a signup flow. " +
      "Cannot change password (use reset_password for that).",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "ATS host" })),
      url: Type.Optional(Type.String({ description: "Full URL — host extracted if 'host' not provided" })),
      company: Type.Optional(Type.String({ description: "Company name (fallback)" })),
      email_used: Type.Optional(Type.String({ description: "New email to use for this account" })),
      ats: Type.Optional(Type.String({ description: "ATS type: 'workday', 'icims', etc." })),
      notes: Type.Optional(Type.String({ description: "Additional notes to append" })),
    }),
    async execute(_toolCallId, params) {
      const host = params.host || (params.url ? extractHost(params.url) : "");
      const company = params.company || (host ? companyFromHost(host) : "");

      let resultKey = "";
      let resultEntry: AccountEntry | null = null;
      const wrote = await mutateAccounts((creds) => {
        const found = findAccount(creds as Credentials, host, company);
        const key = found?.key ?? (host && Object.hasOwn(creds, host) ? host : "");
        if (!key || !creds[key]) return NO_CHANGE;
        if (params.email_used) {
          creds[key].email_used = params.email_used;
          creds[key].username = params.email_used;
        }
        if (params.ats) creds[key].ats = params.ats as AccountEntry["ats"];
        if (params.notes) creds[key].notes = (creds[key].notes || "") + ` | ${params.notes}`;
        creds[key].last_used_at = new Date().toISOString();
        resultKey = key;
        resultEntry = creds[key] as AccountEntry;
        return creds;
      });
      if (!wrote.ok) return credentialsCorruptResult(wrote.error);
      if (!resultEntry) {
        return { content: [{ type: "text", text: `No account found for ${company} (${host}).` }], isError: true };
      }

      return {
        content: [{ type: "text", text: `Updated account for ${resultEntry.company} (${resultKey}).` }],
        details: { key: resultKey, entry: resultEntry },
      };
    },
  });

  // ── Session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (isInWorkspace(ctx.cwd)) {
      const creds = await readCredentialsStrict();
      if ("error" in creds) {
        ctx.ui.notify(credentialsCorruptResult(creds.error).content[0].text, "warning");
        return;
      }
      const count = Object.keys(creds).length;
      ctx.ui.notify(
        `Job Accounts loaded. ${count} ATS account${count === 1 ? "" : "s"} stored. Use /apply-next — account tools activate on login walls.`,
        "info",
      );
    }
  });
}
