#!/usr/bin/env node
/**
 * A fake `pi --mode rpc`: enough of the protocol to drive the run manager
 * through every path it has, and nothing else. Plain Node, no dependencies, no
 * imports from the app — it is spawned as a separate process, exactly as the
 * real binary is.
 *
 * It speaks the same strict JSONL the real one does, including its own LF-only
 * split of stdin, and it ECHOES what it received as a notify so a test can
 * assert what actually crossed the pipe (`steer=true` is otherwise invisible
 * from outside).
 *
 * Behaviour is driven by substrings of the prompt, so a test picks a path by
 * choosing what to say:
 *   "/status" or "/noop"  a command that never starts a turn (idle guard)
 *   "confirm"             raise a confirm dialog and block until answered
 *   "ack-gate"            answer with the applier's ACKNOWLEDGE gate sentence
 *   "ACKNOWLEDGE"         (while the gate is armed) acknowledge and run a turn
 *   "slow"                pause before agent_start, so `starting` is observable
 *   "slowreader"          stop reading stdin for a while (backpressure)
 *   "linger"              after the turn, stop reading stdin and ignore its
 *                         end — only SIGTERM ends this process
 *   "leak <value>"        spray <value> through every channel a password
 *                         really travels on, so redaction can be asserted
 *   "rotate <value>"      say <value> across two text deltas, split inside the
 *                         value, so a test can change the secrets list between
 *   "crash"               exit(2) mid-turn
 *
 * One flag, not a prompt, because it has to act before stdin is ever read:
 *   --die-on-start         exit(3) immediately, as a bad flag makes pi do
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// A pi that dies during startup: an unknown flag, an extension throwing at
// load. It exits before reading stdin and before writing a single line, which
// is the case start() has to survive without losing the `exit`.
if (process.argv.includes("--die-on-start")) process.exit(3);

if (process.argv.includes("--grandchild-sleeper")) {
  setInterval(() => {}, 1000);
} else {
const grandchildFlag = process.argv.indexOf("--spawn-grandchild");
if (grandchildFlag >= 0) {
  const pidFile = process.argv[grandchildFlag + 1];
  const child = spawn(process.execPath, [process.argv[1], "--grandchild-sleeper"], {
    stdio: "ignore",
  });
  fs.writeFileSync(pidFile, String(child.pid));
}

const ESC = String.fromCharCode(27);
/** How long "slowreader" stops reading. Shorter than any test's killGraceMs. */
const SLOW_READER_MS = 400;
/** Longest prompt echoed back in a notify. Every assertion is far shorter. */
const ECHO_MAX = 120;
const GATE_SENTENCE =
  "Legal / ethics note. This agent fills application forms with a fabricated address " +
  "persisted per city. Reply with `ACKNOWLEDGE` in a new message to proceed.";

let uid = 0;
let gateArmed = false;
/** Set by the "linger" turn: stdin's end stops being a reason to exit. */
let lingering = false;
const pendingDialogs = new Map();

// A pi that outlives the abort it was sent. Exiting 0 rather than dying on the
// default disposition keeps the manager's own exit path the one under test.
process.on("SIGTERM", () => {
  const delay = process.argv.indexOf("--term-delay");
  if (delay >= 0) {
    process.removeAllListeners("SIGTERM");
    setTimeout(() => { fs.writeFileSync(process.argv[delay + 1], "cleaned"); process.exit(143); }, 50);
    return;
  }
  if (process.argv.includes("--term-exit-7")) process.exit(7);
  if (process.argv.includes("--term-exit-143")) process.exit(143);
  if (!process.argv.includes("--ignore-term")) process.exit(0);
});

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notify(message, notifyType = "info") {
  write({
    type: "extension_ui_request",
    id: `n${++uid}`,
    method: "notify",
    message,
    notifyType,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dialog(spec) {
  const id = `d${++uid}`;
  return new Promise((resolve) => {
    pendingDialogs.set(id, resolve);
    write({ type: "extension_ui_request", id, ...spec });
  });
}

// ── Startup: what a real workspace's extensions look like on load ──
notify("fake pi loaded");
write({
  type: "extension_ui_request",
  id: `n${++uid}`,
  method: "setStatus",
  statusKey: "mcp",
  // Real pi colours this text; the normalizer has to strip it.
  statusText: `${ESC}[38;2;90;90;90mmcp 0/3 servers${ESC}[0m`,
});

/** One turn at a time, so a steered prompt cannot interleave with the turn it steers. */
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn).catch(() => {});
}

async function runTurn(message) {
  if (message.includes("crash")) {
    process.exit(2);
  }
  if (message.includes("slow")) await sleep(400);
  if (gateArmed && message.includes("ACKNOWLEDGE")) {
    gateArmed = false;
    notify("gate:acknowledged");
  }

  write({ type: "agent_start" });

  // Before the confirm branch: the sentinel itself may contain any substring,
  // so the leak turn is chosen by prefix and answers nothing else.
  if (message.startsWith("leak ")) {
    leakTurn(message.slice("leak ".length).trim());
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }

  if (message.startsWith("rotate ")) {
    rotateTurn(message.slice("rotate ".length).trim());
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }

  if (message.includes("bump-oauth-expires")) {
    bumpOAuthExpires();
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }


  if (message.includes("handoff-apply")) {
    const toolCallId = `call_${++uid}`;
    write({ type: "tool_execution_start", toolCallId, toolName: "start_application", args: {} });
    write({
      type: "tool_execution_end",
      toolCallId,
      toolName: "start_application",
      result: {
        content: [{ type: "text", text: "Starting the application in a dedicated run with the applying model. End your turn now." }],
        details: { handoff: { kind: "apply-next", slug: null } },
      },
      isError: false,
    });
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }

  if (message.includes("verify-otp-leak")) {
    const answer = await dialog({
      method: "input",
      title: "Enter verification code",
      message: "Enter the code from your email",
    });
    const otp = typeof answer.value === "string" ? answer.value : "";
    process.stderr.write(`[fake] leaked verification code: ${otp}\n`);
    process.exit(2);
  }

  if (message.includes("verify-otp")) {
    const answer = await dialog({
      method: "input",
      title: "Enter verification code",
      message: "Enter the code from your email",
    });
    verifyOtpTurn(typeof answer.value === "string" ? answer.value : "");
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
    return;
  }

  if (message.includes("confirm")) {
    const answer = await dialog({
      method: "confirm",
      title: "Proceed?",
      message: "The form is filled. Submit it?",
    });
    if (answer.cancelled) notify("dialog:cancelled");
    else notify(`dialog:confirmed=${answer.confirmed === true}`);
  }

  write({ type: "message_start", message: {} });

  const text = message.includes("ack-gate") ? GATE_SENTENCE : "Opening the posting now. ";
  const size = Math.ceil(text.length / 3);
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (let i = 0; i < 3; i += 1) {
    write({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text.slice(i * size, (i + 1) * size),
      },
    });
  }
  // The text-block terminator is a message_update sub-event, NOT message_end.
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
  });
  if (message.includes("ack-gate")) gateArmed = true;

  const toolCallId = `call_${++uid}`;
  const args = { url: "https://example.test/apply" };
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: toolCallId, toolName: "browser_navigate" },
  });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { id: toolCallId, toolName: "browser_navigate", args },
    },
  });
  write({ type: "tool_execution_start", toolCallId, toolName: "browser_navigate", args });
  write({
    type: "tool_execution_end",
    toolCallId,
    toolName: "browser_navigate",
    result: { content: [{ type: "text", text: "navigated" }] },
    isError: false,
  });

  write({ type: "message_end", message: {} });
  // Both, in order: only agent_settled may flip the panel to `waiting`, and a
  // manager keyed on agent_end would be caught by this pair.
  write({ type: "agent_end", messages: [], willRetry: false });
  write({ type: "agent_settled" });

  // Last, so the turn itself is unaffected: from here the abort command is
  // never read and the closing of stdin is never noticed. Only SIGTERM ends it.
  if (message.includes("linger")) {
    lingering = true;
    process.stdin.pause();
    // A PAUSED stdin does not hold the event loop open. Without a handle of
    // its own this process would exit 0 the moment the turn ends, which is the
    // opposite of what "linger" means — the timer is what makes SIGTERM the
    // only way out. (slowreader gets away without one: its resume is a timer.)
    setInterval(() => {}, 1000);
  }
}

/**
 * One turn that leaks `secret` on every channel a real password travels on:
 * under a `password` key in a tool's args, buried in a free-text arg the way
 * browser_type carries it, in a tool result's prose AND in a JSON blob the way
 * `create_account` prints it (.pi/extensions/job-accounts.ts), in an assistant
 * text delta, SPLIT ACROSS THREE deltas of one text block, and on stderr, where
 * it reaches the client as the tail of a failed exit.
 *
 * The split is the case a per-event literal match cannot catch: real pi chunks
 * a paragraph wherever the model's tokens fall, which is nowhere near a value's
 * boundaries.
 */
function verifyOtpTurn(otp) {
  const toolCallId = `call_${++uid}`;
  write({
    type: "tool_execution_start",
    toolCallId,
    toolName: "browser_fill_form",
    args: { fields: [{ selector: "#otp", value: otp }] },
  });
  write({
    type: "tool_execution_end",
    toolCallId,
    toolName: "browser_fill_form",
    result: {
      content: [{ type: "text", text: `Verification code: ${otp} — use it only for the current verification step.` }],
    },
    isError: false,
  });
  write({ type: "message_start", message: {} });
  const text = `Code received: ${otp} and done.`;
  const half = Math.ceil(text.length / 2);
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(0, half) },
  });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(half) },
  });
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
  });
  write({ type: "message_end", message: {} });
}

function leakTurn(secret) {
  const toolCallId = `call_${++uid}`;
  write({
    type: "tool_execution_start",
    toolCallId,
    toolName: "create_account",
    args: {
      host: "acme.wd5.myworkdayjobs.com",
      password: secret,
      note: `signing up as applicant+acme@example.com with ${secret}`,
    },
  });
  write({
    type: "tool_execution_end",
    toolCallId,
    toolName: "create_account",
    result: {
      content: [
        {
          type: "text",
          text:
            "Created account entry for Acme (acme.wd5.myworkdayjobs.com):\n" +
            "  Username/Email: applicant+acme@example.com\n" +
            `  Password: ${secret}\n` +
            `{"host":"acme.wd5.myworkdayjobs.com","password":"${secret}"}`,
        },
      ],
    },
    isError: false,
  });
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const delta of leakDeltas(secret)) {
    write({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
  process.stderr.write(`[fake] wrote credentials: ${secret}\n`);
}

/**
 * One turn that says `secret` across exactly two deltas, split in the middle of
 * the value: the first is held back by the manager, the second completes it.
 *
 * Two, not the leak turn's three, because a test that wants to change the
 * secrets list mid-block needs one unambiguous boundary to change it at.
 */
function rotateTurn(secret) {
  const half = Math.ceil(secret.length / 2);
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  textDelta(`the password is ${secret.slice(0, half)}`);
  textDelta(`${secret.slice(half)} and log in.`);
  write({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
}

/** Simulates pi refreshing oauth tokens in the per-run auth.json (write-back tests). */
function bumpOAuthExpires() {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return;
  const authPath = path.join(dir, "auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    for (const key of Object.keys(auth)) {
      if (auth[key]?.type === "oauth") {
        auth[key] = {
          ...auth[key],
          access: "FIXTURE-SECRET-do-not-leak-rotated-access",
          expires: Date.now() + 3_600_000,
        };
      }
    }
    fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // ignore
  }
}

function textDelta(delta) {
  write({
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  });
}

/**
 * The leak paragraph, chunked so the second copy of the secret straddles BOTH
 * delta boundaries: no chunk holds it whole and the middle chunk is nothing but
 * secret. runs.test.ts re-derives these thirds to name the fragments it forbids.
 */
function leakDeltas(secret) {
  const third = Math.ceil(secret.length / 3);
  return [
    `Account created; the password is ${secret}. Retype it as ${secret.slice(0, third)}`,
    secret.slice(third, third * 2),
    `${secret.slice(third * 2)} and continue.`,
  ];
}

function handle(command) {
  switch (command.type) {
    case "prompt": {
      const message = String(command.message ?? "");
      const response = { type: "response", command: "prompt", success: true };
      if (command.id) response.id = command.id;
      write(response);
      // Emitted here rather than inside the turn so it is observable even while
      // an earlier turn still holds the queue — which is the whole point of the
      // steer test.
      // Bounded: a backpressure test sends kilobytes of padding, and echoing
      // all of it back would only move the jam to this process's stdout.
      notify(`prompt:${message.slice(0, ECHO_MAX)}|steer=${command.streamingBehavior === "steer"}`);
      if (message.includes("slowreader")) {
        // Stop draining stdin so the next thing the manager writes cannot fit
        // in the pipe and its write() returns false. There is no other way to
        // put the manager's stdin queue under backpressure from out here.
        process.stdin.pause();
        setTimeout(() => process.stdin.resume(), SLOW_READER_MS);
        return;
      }
      if (message.startsWith("/status") || message.startsWith("/noop")) return;
      if (message.includes("env-dump")) {
        notify(
          `env:${process.env.PI_JOBS_RUN_ID ?? ""}|${process.env.PI_JOBS_RUN_DIR ?? ""}|${process.env.PI_JOBS_RUN_KIND ?? ""}|${process.env.PI_JOBS_APPLY_SLUG ?? ""}`,
        );
        return;
      }
      enqueue(() => runTurn(message));
      return;
    }
    case "abort": {
      const orderFile = process.env.PI_JOBS_ABORT_ORDER_LOG;
      if (orderFile) {
        const runDir = process.env.PI_JOBS_RUN_DIR;
        const marker = runDir ? path.join(runDir, "stop.json") : null;
        fs.appendFileSync(orderFile, `abort:${marker && fs.existsSync(marker) ? "marker" : "no-marker"}\n`);
      }
      write({ type: "response", command: "abort", success: true });
      write({ type: "agent_settled" });
      if (process.argv.includes("--abort-exit")) process.exit(0);
      return;
    }
    case "extension_ui_response": {
      const resolve = pendingDialogs.get(command.id);
      if (!resolve) return;
      pendingDialogs.delete(command.id);
      resolve(command);
      return;
    }
    default:
      return;
  }
}

// ── stdin: the same LF-only framing the client owes us ──
const decoder = new StringDecoder("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const record = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (record.length > 0) {
      try {
        handle(JSON.parse(record));
      } catch {
        // ignore anything that is not a command
      }
    }
    index = buffer.indexOf("\n");
  }
});

// Ending stdin is how the run manager releases a settled run; real pi exits 0.
// The drain wait is not ceremony: process.exit() throws away whatever stdout
// still holds, and the last thing written before an abort's EOF is exactly the
// evidence a test is waiting for.
process.stdin.on("end", () => {
  if (lingering) return;
  setImmediate(() => {
    if (process.stdout.writableLength === 0) process.exit(0);
    else process.stdout.once("drain", () => process.exit(0));
  });
});
}
