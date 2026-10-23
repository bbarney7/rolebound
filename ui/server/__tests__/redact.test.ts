import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { MAX_TEXT, SUMMARY_MAX } from "../runs/normalize";
import { REDACTED, redactEvent, redactText, redactValue, splitHoldback } from "../runs/redact";
import { createSecretsReader } from "../runs/secrets";

const SECRET = "xY3!kP9mQr$2wN";
const OTHER = "Zq7&vB1nT";
const secrets = () => [SECRET];

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmFixtureWorkspace(root);
});

describe("redactText", () => {
  it("replaces every occurrence of a known value, punctuation and all", () => {
    // A generated password is `!@#$%^&*` soup — the literal must not be
    // treated as a pattern.
    expect(redactText(`Password: ${SECRET}\nRetype: ${SECRET}`, [SECRET])).toBe(
      "Password: [redacted]\nRetype: [redacted]",
    );
  });

  it("masks a secret-named key in a JSON blob it has never seen the value of", () => {
    const blob = '{"user":"a@b.c","password":"never-seen","apiKey":"nor-this"}';
    expect(redactText(blob, [])).toBe(
      '{"user":"a@b.c","password":"[redacted]","apiKey":"[redacted]"}',
    );
  });

  it("does not end a masked value early on an escaped quote", () => {
    expect(redactText('{"password":"a\\"b","after":1}', [])).toBe(
      '{"password":"[redacted]","after":1}',
    );
  });

  it("replaces the longest value first, whatever order it was handed them in", () => {
    // `abc` first would leave `def` — the tail of the longer secret — behind.
    expect(redactText("token=abcdef", ["abc", "abcdef"])).toBe(`token=${REDACTED}`);
    expect(redactText("token=abcdef", ["abcdef", "abc"])).toBe(`token=${REDACTED}`);
  });

  it("does the same when one secret is a suffix of another", () => {
    expect(redactText("token=abcdef", ["def", "abcdef"])).toBe(`token=${REDACTED}`);
    expect(redactText("token=def", ["def", "abcdef"])).toBe(`token=${REDACTED}`);
  });

  it("leaves text with nothing to hide untouched", () => {
    expect(redactText("navigated to https://example.test/apply", [SECRET])).toBe(
      "navigated to https://example.test/apply",
    );
  });
});

/**
 * What `RunManager.emit` does with one assistant text block: carry a holdback
 * across deltas, redact what is released, flush what is left at `text_end`.
 */
function stream(deltas: readonly string[], list: readonly string[]): string[] {
  const out: string[] = [];
  let holdback = "";
  for (const delta of deltas) {
    const split = splitHoldback(holdback + delta, list);
    holdback = split.holdback;
    if (split.emit) out.push(redactText(split.emit, list));
  }
  if (holdback) out.push(redactText(holdback, list));
  return out;
}

describe("splitHoldback", () => {
  it("holds back only what could still become a secret", () => {
    expect(splitHoldback(`saying ${SECRET.slice(0, 3)}`, [SECRET])).toEqual({
      emit: "saying ",
      holdback: SECRET.slice(0, 3),
    });
    expect(splitHoldback("saying nothing", [SECRET])).toEqual({
      emit: "saying nothing",
      holdback: "",
    });
    // A whole secret is a hit, not a partial match: it must reach redactText.
    expect(splitHoldback(SECRET, [SECRET])).toEqual({ emit: SECRET, holdback: "" });
  });

  it("catches a secret split after its first character", () => {
    expect(stream([`it is ${SECRET.slice(0, 1)}`, SECRET.slice(1)], [SECRET])).toEqual([
      "it is ",
      "[redacted]",
    ]);
  });

  it("catches a secret split before its last character", () => {
    expect(stream([`it is ${SECRET.slice(0, -1)}`, SECRET.slice(-1)], [SECRET])).toEqual([
      "it is ",
      "[redacted]",
    ]);
  });

  it("catches a secret spread over three deltas", () => {
    const emitted = stream([SECRET.slice(0, 4), SECRET.slice(4, 9), `${SECRET.slice(9)} done`], [
      SECRET,
    ]);
    expect(emitted.join("")).toBe("[redacted] done");
    expect(emitted.join("")).not.toContain(SECRET.slice(0, 4));
  });

  it("releases a prefix that never completes, verbatim, at the end of the block", () => {
    // `xY3` is where a secret starts and also just a word: holding it forever
    // would swallow the last sentence of every turn.
    expect(stream(["all done xY3"], [SECRET])).toEqual(["all done ", "xY3"]);
  });

  it("keeps up with two secrets running back to back", () => {
    expect(
      stream([SECRET.slice(0, 5), SECRET.slice(5) + OTHER.slice(0, 3), OTHER.slice(3)], [
        SECRET,
        OTHER,
      ]).join(""),
    ).toBe("[redacted][redacted]");
  });

  it("holds nothing back when there is nothing to hold back", () => {
    expect(splitHoldback("plain text", [])).toEqual({ emit: "plain text", holdback: "" });
    expect(splitHoldback("", [SECRET])).toEqual({ emit: "", holdback: "" });
    expect(stream(["", "hi"], [SECRET])).toEqual(["hi"]);
  });
});

describe("redactValue", () => {
  it("drops the value of a secret-named key at any depth", () => {
    expect(
      redactValue({ fields: [{ name: "Password", new_password: "abc" }], keep: "yes" }, []),
    ).toEqual({ fields: [{ name: "Password", new_password: "[redacted]" }], keep: "yes" });
  });

  it("catches a password under a key that names nothing", () => {
    // browser_type's shape: the key is `text`, the value is the password.
    expect(redactValue({ element: "Password field", text: SECRET }, [SECRET])).toEqual({
      element: "Password field",
      text: "[redacted]",
    });
  });
});

describe("secret key names", () => {
  // One source string feeds the JSON-pair pattern and the key test, so each
  // name is asserted on both surfaces.
  const NAMES = [
    "pwd",
    "passphrase",
    "authorization",
    "cookie",
    "set-cookie",
    "bearer",
    "session_id",
    "sessionToken",
    "session_key",
  ];

  it("masks the value of every key name a login flow can carry", () => {
    for (const key of NAMES) {
      expect(redactText(`{"${key}":"do-not-print"}`, [])).toBe(`{"${key}":"${REDACTED}"}`);
      expect(redactValue({ [key]: "do-not-print" }, [])).toEqual({ [key]: REDACTED });
    }
  });

  it("leaves the run's own session words alone", () => {
    // The panel's summary says `sessionName`; a tool that prints a
    // `sessionFile` path is not printing a credential.
    const readable = { session: "ui:alpha", sessionName: "ui:alpha", sessionFile: "/x/s.json" };
    expect(redactValue(readable, [])).toEqual(readable);
    expect(redactText(JSON.stringify(readable), [])).toBe(JSON.stringify(readable));
  });
});

describe("redactEvent", () => {
  it("scrubs tool args, the one-line summary and a tool result", () => {
    expect(
      redactEvent(
        {
          type: "tool_start",
          toolCallId: "1",
          name: "create_account",
          summary: `password ${SECRET}`,
          args: { host: "acme.wd5.myworkdayjobs.com", password: SECRET },
        },
        secrets,
      ),
    ).toEqual({
      type: "tool_start",
      toolCallId: "1",
      name: "create_account",
      summary: "password [redacted]",
      args: { host: "acme.wd5.myworkdayjobs.com", password: "[redacted]" },
    });

    expect(
      redactEvent({ type: "tool_end", toolCallId: "1", isError: false, result: `New password: ${SECRET}` }, secrets),
    ).toMatchObject({ result: "New password: [redacted]" });
  });

  it("redacts a long result before capping it, not after", () => {
    // The secret straddles the cap: it starts at MAX_TEXT - "[redacted]".length
    // and runs past MAX_TEXT. Capping first would publish its first characters
    // and drop the rest, which is a leak spelled as a truncation.
    const head = "x".repeat(MAX_TEXT - REDACTED.length);
    const tail = "y".repeat(5000 - head.length - SECRET.length);
    const result = `${head}${SECRET}${tail}`;
    expect(result).toHaveLength(5000);

    const { result: capped } = redactEvent(
      { type: "tool_end", toolCallId: "1", isError: false, result },
      secrets,
    ) as { result: string };

    expect(capped).not.toContain(SECRET);
    expect(capped.slice(0, MAX_TEXT)).toBe(`${head}${REDACTED}`);
    // The cap plus truncate's own marker, and nothing else.
    expect(capped).toBe(`${head}${REDACTED}… [truncated 900 chars]`);
  });

  it("redacts the one-line summary before capping it, not after", () => {
    // The secret straddles character 80 of the summary. Capping first leaves
    // its first characters in the one row a collapsed tool call always shows.
    const head = "u".repeat(SUMMARY_MAX - 13);
    const summary = `${head}${SECRET}!`;
    expect(summary.length).toBeGreaterThan(SUMMARY_MAX);

    const capped = (
      redactEvent(
        { type: "tool_start", toolCallId: "1", name: "browser_type", summary, args: {} },
        secrets,
      ) as { summary: string }
    ).summary;

    expect(capped).not.toContain(SECRET.slice(0, 4));
    // Short enough after redaction that the cap has nothing left to do.
    expect(capped).toBe(`${head}${REDACTED}!`);
  });

  it("still caps a summary that is long after redaction", () => {
    const capped = (
      redactEvent(
        {
          type: "tool_start",
          toolCallId: "1",
          name: "browser_navigate",
          summary: "z".repeat(200),
          args: {},
        },
        secrets,
      ) as { summary: string }
    ).summary;
    expect(capped).toBe(`${"z".repeat(SUMMARY_MAX - 1)}…`);
  });

  it("scrubs text deltas, notifies and the stderr tail of a failed exit", () => {
    expect(redactEvent({ type: "text", delta: `it is ${SECRET}` }, secrets)).toMatchObject({
      delta: "it is [redacted]",
    });
    expect(
      redactEvent({ type: "notify", level: "warning", message: SECRET }, secrets),
    ).toMatchObject({ message: "[redacted]" });
    expect(redactEvent({ type: "error", message: `boom ${SECRET}` }, secrets)).toMatchObject({
      message: "boom [redacted]",
    });
  });

  it("costs nothing for an event that cannot carry a secret", () => {
    let calls = 0;
    const counted = () => {
      calls += 1;
      return [SECRET];
    };
    expect(redactEvent({ type: "exit", code: 0, signal: null }, counted)).toEqual({
      type: "exit",
      code: 0,
      signal: null,
    });
    expect(calls).toBe(0);
  });
});

describe("createSecretsReader", () => {
  it("picks up a password written mid-run, without re-reading an unchanged file", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const read = createSecretsReader(root, {});

    expect(read.read()).toContain(SENTINEL_PASSWORD);
    // Same file, same array: the stat is the only per-event cost.
    expect(read.read()).toBe(read.read());

    // What create_account does halfway through a run.
    const file = path.join(root, "credentials.json");
    const creds = JSON.parse(await fs.readFile(file, "utf-8"));
    creds["new.wd5.myworkdayjobs.com"] = { username: "a@b.c", password: SECRET };
    await fs.writeFile(file, JSON.stringify(creds, null, 2));

    expect(read.read()).toContain(SECRET);
  });

  it("re-reads a rewrite that kept the file's size and its mtime", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const file = path.join(root, "credentials.json");
    const stamped = new Date("2026-01-01T00:00:00Z");
    const entry = (password: string) =>
      JSON.stringify({ "acme.wd5.myworkdayjobs.com": { username: "a@b.c", password } });

    await fs.writeFile(file, entry("AAAAAAAAAAAA"));
    await fs.utimes(file, stamped, stamped);
    const read = createSecretsReader(root, {});
    expect(read.read()).toContain("AAAAAAAAAAAA");

    // Same length, same restored mtime: everything the old `mtimeMs:size`
    // stamp could see is unchanged, which is the point of the assertions.
    const before = await fs.stat(file);
    await fs.writeFile(file, entry("BBBBBBBBBBBB"));
    await fs.utimes(file, stamped, stamped);
    const after = await fs.stat(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    expect(read.read()).toContain("BBBBBBBBBBBB");
    expect(read.read()).not.toContain("AAAAAAAAAAAA");
  });

  it("collects a credential filed under any of the shared key names", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    await fs.writeFile(
      path.join(root, "credentials.json"),
      JSON.stringify({
        "acme.wd5.myworkdayjobs.com": {
          username: "applicant+acme@example.com",
          pwd: "pwd-value",
          cookie: "cookie-value",
          session_id: "session-id-value",
          notes: "created during application",
        },
      }),
    );
    const read = createSecretsReader(root, {});
    expect([...read.read()].sort()).toEqual(["cookie-value", "pwd-value", "session-id-value"]);
  });

  it("hands its values out longest first", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    // Written short-first, so the order below can only come from the reader.
    await fs.writeFile(
      path.join(root, "credentials.json"),
      JSON.stringify({
        "acme.wd5.myworkdayjobs.com": { password: "abcd" },
        "beta.icims.com": { password: "abcdefgh" },
      }),
    );
    expect(createSecretsReader(root, {}).read()).toEqual(["abcdefgh", "abcd"]);
  });

  it("includes the two OAuth values when they are set, and survives a missing file", () => {
    const read = createSecretsReader(path.join("/nonexistent-workspace"), {
      GOOGLE_OAUTH_CLIENT_ID: "client-id-value",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-value",
    });
    expect([...read.read()].sort()).toEqual(["client-id-value", "client-secret-value"]);
  });

  it("harvests the CAPTCHA key from settings.json and re-reads when that file changes", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const read = createSecretsReader(root, {});
    // makeFixtureWorkspace's own credentials.json already seeds secrets (every
    // other case in this block relies on that), so the assertion here is
    // containment of the settings key, not the whole array — toEqual([]) would
    // fail on the fixture's baked-in credentials, not on missing settings.json
    // support.
    expect(read.read()).not.toContain("SETTINGS-KEY-1234");
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ captcha: { provider: "2captcha", api_key: "SETTINGS-KEY-1234" } }));
    expect(read.read()).toContain("SETTINGS-KEY-1234");
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ captcha: { provider: "2captcha", api_key: "SETTINGS-KEY-5678" } }));
    expect(read.read()).toContain("SETTINGS-KEY-5678");
    expect(read.read()).not.toContain("SETTINGS-KEY-1234");
  });

  it("includes both provider env vars alongside the OAuth pair", () => {
    const read = createSecretsReader(path.join("/nonexistent-workspace"), {
      CAPSOLVER_API_KEY: "CAP-env-value",
      TWOCAPTCHA_API_KEY: "two-env-value",
    });
    expect([...read.read()].sort()).toEqual(["CAP-env-value", "two-env-value"]);
  });
  it("harvests app-owned model credentials and standard provider env keys", async () => {
    const root = await makeFixtureWorkspace(); roots.push(root); await fs.mkdir(path.join(root, ".pi-jobs", "pi-agent"), { recursive: true });
    await fs.writeFile(path.join(root, ".pi-jobs", "pi-agent", "auth.json"), JSON.stringify({ alias: { type: "api_key", key: "MODEL-STORED-SECRET" } }));
    const read = createSecretsReader(root, { OPENAI_API_KEY: "MODEL-ENV-SECRET" }); expect(read.read()).toContain("MODEL-STORED-SECRET"); expect(read.read()).toContain("MODEL-ENV-SECRET");
  });

  it("harvests catalog provider env keys such as OpenRouter and Cursor", () => {
    const read = createSecretsReader(path.join("/nonexistent-workspace"), {
      OPENROUTER_API_KEY: "openrouter-env-secret",
      CURSOR_API_KEY: "cursor-env-secret",
    });
    expect(read.read()).toContain("openrouter-env-secret");
    expect(read.read()).toContain("cursor-env-secret");
  });

  it("collects oauth access and refresh tokens from auth.json and extra paths", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const access = "FIXTURE-SECRET-do-not-leak-oauth-access";
    const refresh = "FIXTURE-SECRET-do-not-leak-oauth-refresh";
    const rotated = "FIXTURE-SECRET-do-not-leak-oauth-rotated";
    await fs.mkdir(path.join(root, ".pi-jobs", "pi-agent"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".pi-jobs", "pi-agent", "auth.json"),
      JSON.stringify({
        "pi-jobs-conn": { type: "oauth", access, refresh, expires: Date.now() + 60_000 },
      }),
    );
    const reader = createSecretsReader(root, {});
    expect(reader.read()).toEqual(expect.arrayContaining([access, refresh]));
    const runAuth = path.join(root, ".pi-jobs", "runs", "run-1", "pi-agent", "auth.json");
    await fs.mkdir(path.dirname(runAuth), { recursive: true });
    await fs.writeFile(
      runAuth,
      JSON.stringify({ anthropic: { type: "oauth", access: rotated, refresh, expires: Date.now() + 120_000 } }),
    );
    reader.addPath(runAuth);
    expect(reader.read()).toEqual(expect.arrayContaining([access, refresh, rotated]));
    reader.snapshotPath(runAuth);
    reader.removePath(runAuth);
    await fs.rm(runAuth);
    expect(reader.read()).toContain(rotated);
    reader.dropSnapshot(runAuth);
    expect(reader.read()).not.toContain(rotated);
  });

  it("retains the last valid path secrets and extracts rotated tokens from malformed JSON", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const runAuth = path.join(root, ".pi-jobs", "runs", "run-malformed", "pi-agent", "auth.json");
    const original = "FIXTURE-SECRET-do-not-leak-original-access";
    const rotatedAccess = "FIXTURE-SECRET-do-not-leak-rotated-access";
    const rotatedRefresh = "FIXTURE-SECRET-do-not-leak-rotated-refresh";
    const skToken = "sk-FIXTURE-SECRET-do-not-leak-raw";
    const oatToken = "oat01-FIXTURE-SECRET-do-not-leak-raw";
    await fs.mkdir(path.dirname(runAuth), { recursive: true });
    await fs.writeFile(
      runAuth,
      JSON.stringify({ anthropic: { type: "oauth", access: original, refresh: "old-refresh", expires: 1 } }),
    );
    const reader = createSecretsReader(root, {});
    reader.addPath(runAuth);
    expect(reader.read()).toContain(original);
    expect(reader.isPathUnreadable(runAuth)).toBe(false);

    const malformed = `{"loose":"${skToken} ${oatToken}","anthropic":{"type":"oauth","access":"${rotatedAccess}","refresh":"${rotatedRefresh}","expires":`;
    await fs.writeFile(runAuth, malformed);

    expect(reader.isPathUnreadable(runAuth)).toBe(true);
    expect(reader.read()).toEqual(
      expect.arrayContaining([original, rotatedAccess, rotatedRefresh, skToken, oatToken]),
    );
  });
});

describe("oauth token redaction in streamed text", () => {
  const access = "FIXTURE-SECRET-do-not-leak-stream-access";
  const refresh = "FIXTURE-SECRET-do-not-leak-stream-refresh";
  const rotated = "FIXTURE-SECRET-do-not-leak-stream-rotated";

  it("redacts plaintext and split-delta leakage for original and rotated oauth tokens", () => {
    const original = [access, refresh];
    expect(redactText(`token ${access} done`, original)).not.toContain(access);
    expect(stream([access.slice(0, 4), access.slice(4)], original).join("")).not.toContain(access);
    const rotatedList = [access, refresh, rotated];
    expect(redactText(`rotated ${rotated}`, rotatedList)).not.toContain(rotated);
    expect(stream([rotated.slice(0, 5), rotated.slice(5)], rotatedList).join("")).not.toContain(rotated);
    expect(redactText(`refresh ${refresh}`, rotatedList)).not.toContain(refresh);
  });
});
