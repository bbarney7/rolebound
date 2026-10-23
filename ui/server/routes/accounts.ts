import { Router, type Request } from "express";
import { listApplications } from "../union";
import { readAccounts, readRawCredentials, toAtsAccount } from "../readers/credentials";
import {
  createAccountEntry,
  deleteAccountEntry,
  normalizeHost,
  updateAccountEntry,
  type AccountWriteError,
  type CreateAccountFields,
  type UpdateAccountChanges,
} from "../accountsWriter";
import { findAccount } from "./applications";
import { MIN_SECRET_LENGTH } from "../runs/secrets";
import {
  ATS_KINDS,
  LOGIN_STATUSES,
  type AccountCreateBody,
  type AccountDetailPayload,
  type AccountMutationResult,
  type AccountUpdateBody,
  type ATSAccount,
  type RawCredentialEntry,
} from "../../shared/types";

const BAD_HOST = { error: "invalid host" };
const NOT_FOUND = { error: "account not found" };
const NO_PASSWORD = { error: "no password on file" };
const NO_FIELDS = { error: "no fields to update" };

/** Every text field but `notes`; `notes` gets its own, larger bound. */
const MAX_TEXT_LENGTH = 512;
const MAX_NOTES_LENGTH = 4000;

/** A 400 body that names the control the form should mark invalid. */
type FieldError = { error: string; field: string };

/**
 * HOW `:host` IS RESOLVED — Decision 2, and it is binding.
 *
 * readAccounts lists whatever raw keys credentials.json holds, so a row can
 * exist for a key normalizeHost would reject: extractHost
 * (.pi/extensions/job-accounts.ts:73) returns `new URL(url).host`, which INCLUDES
 * A PORT, and a hand-edited file can hold anything a person typed. If the lookup
 * routes normalized, such a row would be listed but unopenable, uneditable and
 * undeletable — visible in the table, 400 from every route that could manage it.
 *
 * So this bounds the input and rewrites nothing: no trim, no case fold, no
 * trailing-dot strip. The value that survives is used for an OWN-PROPERTY lookup
 * against the parsed map, so whatever key is in the file is addressable and
 * anything else is a plain 404. Safe because the host NEVER touches the
 * filesystem — it is only ever an object key, and paths.credentials(root) is a
 * fixed path.
 *
 * Express has already percent-decoded the parameter, and a malformed escape
 * (`%E0%A4%A`) never reaches a handler at all: decodeParam throws a URIError
 * inside router/lib/layer.js and Express answers 400 on its own. So there is no
 * percent-decoding logic here and no try/catch.
 */
function hostParam(req: Request): string | null {
  const host = req.params.host;
  if (typeof host !== "string") return null;
  if (host === "" || host.length > 253) return null;
  if (/[\u0000-\u001f\u007f]/.test(host)) return null;
  return host;
}

/** AC 2's order: most recently used first, never-used last, ties broken by host. */
function byLastUsedThenHost(a: ATSAccount, b: ATSAccount): number {
  if (a.lastUsedAt === null && b.lastUsedAt !== null) return 1;
  if (a.lastUsedAt !== null && b.lastUsedAt === null) return -1;
  if (a.lastUsedAt !== null && b.lastUsedAt !== null) {
    const byDate = b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (byDate !== 0) return byDate;
  }
  return a.host.localeCompare(b.host);
}

/**
 * The one place the writer's codes become statuses, shared by all three mutation
 * routes so the four 409s and the one 404 cannot drift apart route by route.
 */
function writeErrorStatus(code: AccountWriteError["code"]): number {
  return code === "NOT_FOUND" ? 404 : 409;
}

/**
 * The same length limits on POST and PATCH, in one helper both call. A PATCH
 * that accepted a 5000-character `notes` after POST rejected one is a hole in the
 * same wall: every value in this file is equally hand-editable afterwards, and
 * the limits exist to keep the file readable and the writes small.
 */
function checkLength(field: string, value: string): FieldError | null {
  const limit = field === "notes" ? MAX_NOTES_LENGTH : MAX_TEXT_LENGTH;
  if (value.length <= limit) return null;
  return { error: `${field} must be ${limit} characters or fewer`, field };
}

/**
 * THE REDACTION FLOOR, ENFORCED ON THE WAY IN — the same helper on POST and PATCH.
 *
 * runs/secrets.ts only collects a stored password into the redaction set when it
 * is at least MIN_SECRET_LENGTH characters, so anything shorter is a credential
 * the transcript redactor cannot protect. The JSON key masking would still catch
 * `"password": "abc"`, but redact.ts's free-text pass replaces only COLLECTED
 * values, so a run that printed `Password: abc` would disclose it through
 * /api/runs/current and /api/runs/events — the guarantee AC 4 makes. Refusing the
 * write is the only way to keep every stored password redactable, and the number
 * is read from the redactor's own constant rather than repeated here, so the two
 * sides cannot drift.
 *
 * Applied to the value AS SENT, untrimmed, exactly like the storage rule: "   "
 * is three spaces, not empty, and is now refused for being three characters.
 */
function checkRedactable(value: string): FieldError | null {
  if (value.length >= MIN_SECRET_LENGTH) return null;
  return {
    error: `password must be at least ${MIN_SECRET_LENGTH} characters — shorter values cannot be redacted from run transcripts`,
    field: "password",
  };
}

function enumError(field: string, allowed: readonly string[]): FieldError {
  return { error: `${field} must be one of: ${allowed.join(", ")}`, field };
}

/**
 * readAccounts keeps its own host sort because findAccount depends on it (R9);
 * AC 2's order is applied here, on a copy, so the reader's array is
 * unmistakably untouched.
 */
async function listSorted(root: string): Promise<ATSAccount[]> {
  const accounts = await readAccounts(root);
  return [...accounts].sort(byLastUsedThenHost);
}

/**
 * THE MUTATION ROUTES NEVER SERIALIZE THE WRITER'S RAW ENTRY.
 *
 * AccountWriteResult.entry is a RawCredentialEntry, so it CAN carry a password —
 * createAccountEntry returns the entry it just wrote and deleteAccountEntry
 * returns the entry it captured before removing it. Putting either into a
 * response body directly would make POST and DELETE leak a password while
 * readAccounts was still carefully stripping one two files away. So every
 * mutation response's `account` is built by passing the raw entry through
 * toAtsAccount — the exact function readAccounts calls, not a second mapping
 * written here — and `accounts` is a plain re-read. AccountMutationResult is
 * ATSAccounts and nothing else.
 */
async function mutationResult(
  root: string,
  host: string,
  entry: RawCredentialEntry,
): Promise<AccountMutationResult> {
  return { accounts: await listSorted(root), account: toAtsAccount(host, entry) };
}

/**
 * An optional free-text field: absent stays absent, a non-string is a 400, and a
 * value that trims to blank is omitted rather than stored as "". The length bound
 * is applied to the value AS SENT, before trimming.
 */
type OptionalText = { ok: true; value: string | undefined } | { ok: false; body: FieldError };

function optionalText(raw: unknown, field: string): OptionalText {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, body: { error: `${field} must be a string`, field } };
  }
  const lengthError = checkLength(field, raw);
  if (lengthError) return { ok: false, body: lengthError };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

export function accountsRouter(root: string): Router {
  const router = Router();

  /**
   * A corrupt credentials.json reaches Express's default handler here and
   * answers 500 with an HTML body — app.ts has no trailing error handler. That
   * is deliberate: it is AC 2's error state, and a read has nothing useful to
   * say about a file it cannot parse. The mutation routes answer the same file
   * with a JSON 409, because a mutation's error has to reach the form.
   */
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await listSorted(root));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:host", async (req, res, next) => {
    try {
      const host = hostParam(req);
      if (host === null) {
        res.status(400).json(BAD_HOST);
        return;
      }
      const [accounts, applications] = await Promise.all([
        readAccounts(root),
        listApplications(root),
      ]);
      const account = accounts.find((a) => a.host === host);
      if (!account) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      // Passing the FULL accounts array to findAccount is what makes this the
      // exact inverse of the application→account direction — a filtered array
      // would change which account wins the exact-host rule (AC 3).
      const payload: AccountDetailPayload = {
        account,
        applications: applications.filter((app) => findAccount(app, accounts)?.host === host),
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  /**
   * The one route that normalizes, because it is the one route that mints a key.
   *
   * There is deliberately NO pre-flight read of credentials.json here. It would
   * buy almost nothing — refusing an obvious duplicate without taking a lock held
   * for milliseconds — and it could only introduce a defect: readRawCredentials
   * throws on a corrupt or malformed file, and with no error handler in app.ts an
   * uncaught throw would answer Express's HTML 500 on exactly the case this
   * route promises a JSON 409 for. The writer's locked read is the only read on
   * this path, and its catch is the only place corrupt-file handling has to be
   * correct. The case-variant refusal lives there too, inside the lock.
   */
  router.post("/", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<AccountCreateBody>;

      if (typeof body.host !== "string" || body.host.trim() === "") {
        res.status(400).json({ error: "host is required", field: "host" });
        return;
      }
      const host = normalizeHost(body.host);
      if (host === null) {
        res.status(400).json({
          error: "host must be a bare hostname, e.g. acme.wd5.myworkdayjobs.com",
          field: "host",
        });
        return;
      }

      if (typeof body.username !== "string" || body.username.trim() === "") {
        res.status(400).json({ error: "username is required", field: "username" });
        return;
      }
      const usernameLength = checkLength("username", body.username);
      if (usernameLength) {
        res.status(400).json(usernameLength);
        return;
      }

      let ats = "other";
      if (body.ats !== undefined) {
        if (typeof body.ats !== "string" || !(ATS_KINDS as readonly string[]).includes(body.ats)) {
          res.status(400).json(enumError("ats", ATS_KINDS));
          return;
        }
        ats = body.ats;
      }

      const optional: Record<string, string | undefined> = {};
      for (const field of ["emailUsed", "company", "notes"] as const) {
        const parsed = optionalText(body[field], field);
        if (!parsed.ok) {
          res.status(400).json(parsed.body);
          return;
        }
        optional[field] = parsed.value;
      }

      // A PASSWORD IS OPAQUE AND IS NEVER TRIMMED. Every other optional string is
      // trimmed and dropped when blank, because a leading space in a company name
      // is a typo. A password is a credential that must be reproduced
      // byte-for-byte at a login form, and " hunter2 " is a different secret from
      // "hunter2"; trimming stores a value that silently never works, invisibly,
      // because the field is masked. So: take the string exactly as sent, and omit
      // the key only when it is EXACTLY "". On create a blank password is not an
      // error — it just means no password was recorded. A password of three
      // spaces is still not "empty", and is now refused by checkRedactable for
      // being three characters rather than for being blank.
      let password: string | undefined;
      if (body.password !== undefined) {
        if (typeof body.password !== "string") {
          res.status(400).json({ error: "password must be a string", field: "password" });
          return;
        }
        const passwordLength = checkLength("password", body.password);
        if (passwordLength) {
          res.status(400).json(passwordLength);
          return;
        }
        // The redaction floor applies only to a value that will actually be
        // STORED: "" still means "no password recorded" and omits the key, which
        // is not an error and has nothing for the redactor to miss.
        if (body.password !== "") {
          const tooShort = checkRedactable(body.password);
          if (tooShort) {
            res.status(400).json(tooShort);
            return;
          }
          password = body.password;
        }
      }

      const fields: CreateAccountFields = {
        username: body.username.trim(),
        ats,
        ...(password !== undefined ? { password } : {}),
        ...(optional.emailUsed !== undefined ? { emailUsed: optional.emailUsed } : {}),
        ...(optional.company !== undefined ? { company: optional.company } : {}),
        ...(optional.notes !== undefined ? { notes: optional.notes } : {}),
      };

      const result = await createAccountEntry(root, host, fields);
      if (!result.ok) {
        res.status(writeErrorStatus(result.error.code)).json({ error: result.error.message });
        return;
      }
      res.status(201).json(await mutationResult(root, host, result.entry));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:host", async (req, res, next) => {
    try {
      const host = hostParam(req);
      if (host === null) {
        res.status(400).json(BAD_HOST);
        return;
      }
      const body = (req.body ?? {}) as Partial<AccountUpdateBody>;
      const changes: UpdateAccountChanges = {};
      let present = 0;

      // Presence is the discriminator and hasOwnProperty is what reads it —
      // destructuring cannot tell absent from null-valued (applications.ts:160).
      const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

      for (const [wire, raw] of [
        ["username", "username"],
        ["emailUsed", "email_used"],
        ["company", "company"],
        ["notes", "notes"],
      ] as const) {
        if (!has(wire)) continue;
        present++;
        const value = body[wire];
        if (value === null) {
          changes[raw] = null;
          continue;
        }
        if (typeof value !== "string") {
          res.status(400).json({ error: `${wire} must be a string`, field: wire });
          return;
        }
        const lengthError = checkLength(wire, value);
        if (lengthError) {
          res.status(400).json(lengthError);
          return;
        }
        changes[raw] = value.trim();
      }

      for (const [wire, raw, allowed] of [
        ["ats", "ats", ATS_KINDS],
        ["lastLoginStatus", "last_login_status", LOGIN_STATUSES],
      ] as const) {
        if (!has(wire)) continue;
        present++;
        const value = body[wire];
        if (value === null) {
          changes[raw] = null;
          continue;
        }
        if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
          res.status(400).json(enumError(wire, allowed));
          return;
        }
        changes[raw] = value;
      }

      // PASSWORD HAS THREE STATES AND NO FOURTH. Absent keeps the stored value;
      // null removes the key; any other string replaces it VERBATIM (no trim, no
      // normalization). An explicit "" is REJECTED rather than interpreted,
      // because a blank text input is the single most likely thing to arrive here
      // and the two plausible readings — "keep what is stored" and "delete the
      // credential" — differ by destroying data the user cannot recover from this
      // UI. The refusal is on the UNTRIMMED value: "   " is three spaces, not
      // empty — it reaches the stored branch and is then refused by
      // checkRedactable, which counts the same three characters.
      if (has("password")) {
        present++;
        const value = body.password;
        if (value === null) {
          changes.password = null;
        } else if (typeof value !== "string") {
          res.status(400).json({ error: "password must be a string", field: "password" });
          return;
        } else if (value === "") {
          res.status(400).json({
            error: "password must not be empty (send null to remove it)",
            field: "password",
          });
          return;
        } else {
          const passwordLength = checkLength("password", value);
          if (passwordLength) {
            res.status(400).json(passwordLength);
            return;
          }
          const tooShort = checkRedactable(value);
          if (tooShort) {
            res.status(400).json(tooShort);
            return;
          }
          changes.password = value;
        }
      }

      if (present === 0) {
        res.status(400).json(NO_FIELDS);
        return;
      }

      // last_used_at is deliberately NOT bumped — the agent owns that field, and
      // editing a note is not a login. `notes` REPLACES rather than appending;
      // the extension appends with " | ", but the UI is an editor.
      const result = await updateAccountEntry(root, host, changes);
      if (!result.ok) {
        res.status(writeErrorStatus(result.error.code)).json({ error: result.error.message });
        return;
      }
      res.json(await mutationResult(root, host, result.entry));
    } catch (err) {
      next(err);
    }
  });

  /**
   * A missing credentials.json is a 404 here and on PATCH, never a 500: the
   * writer checks for the file before locking, because withLock requires the
   * target to exist and would otherwise reject ENOENT straight into Express's
   * default handler. Deleting an account that has no file is a 404 for the same
   * reason deleting an account that is not in the file is — the thing being
   * addressed is not there.
   *
   * This handler reads no body at all. Saying so explicitly is the point: a
   * delete that silently accepted and parsed one would invite the next person to
   * add a field to it.
   */
  router.delete("/:host", async (req, res, next) => {
    try {
      const host = hostParam(req);
      if (host === null) {
        res.status(400).json(BAD_HOST);
        return;
      }
      const result = await deleteAccountEntry(root, host);
      if (!result.ok) {
        res.status(writeErrorStatus(result.error.code)).json({ error: result.error.message });
        return;
      }
      // The pre-delete entry, stripped, as `account`; the post-delete list as
      // `accounts`, from which it is deliberately absent.
      res.json(await mutationResult(root, host, result.entry));
    } catch (err) {
      next(err);
    }
  });

  /**
   * THE ONE ROUTE THAT RETURNS A PASSWORD (Decision 1).
   *
   * POST, not GET, so it cannot be prefetched, bookmarked, cached, or land in a
   * referrer — not because it mutates. It takes no lock, calls no writer, and
   * reads no body: it is a READ of the file, so a corrupt file throws out of
   * readRawCredentials and reaches a 500 exactly like the GETs. Do NOT add a
   * try/catch that turns that into a 409; nothing in this handler is protecting
   * any bytes.
   *
   * The response carries EXACTLY one key, so a leak assertion can pin its shape.
   * Never log anything from here.
   */
  router.post("/:host/reveal", async (req, res, next) => {
    try {
      const host = hostParam(req);
      if (host === null) {
        res.status(400).json(BAD_HOST);
        return;
      }
      const raw = await readRawCredentials(root);
      if (!Object.hasOwn(raw, host)) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const stored = raw[host].password;
      if (typeof stored !== "string" || stored.length === 0) {
        res.status(404).json(NO_PASSWORD);
        return;
      }
      res.set("Cache-Control", "no-store");
      res.json({ password: stored });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
