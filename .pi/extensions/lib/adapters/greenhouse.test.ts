import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAnswerTemplate,
  compactSchema,
  DECLINE_ANSWER,
  elementRef,
  fetchJobSchema,
  generateFillScript,
  generateOtpScript,
  generateSubmitScript,
  groupRefFor,
  isValidElementId,
  parseGreenhouseUrl,
  selectorFor,
  validateAnswers,
} from "./greenhouse";
import type {
  CompactQuestion,
  CompactSchema,
  FieldError,
  FilledField,
  ResolvedAnswer,
  SkippedField,
} from "./greenhouse";

// The exact User-Agent job-gatherer.ts sends. Asserted verbatim so a future edit to
// the adapter's copy of the constant fails here instead of silently drifting.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const AMPLITUDE_FIXTURE = readFileSync(
  new URL("./__fixtures__/amplitude-8654510002.json", import.meta.url),
  "utf-8",
);

const ANTHROPIC_FIXTURE = readFileSync(
  new URL("./__fixtures__/anthropic-5304425008.json", import.meta.url),
  "utf-8",
);

const DATADOG_FIXTURE = readFileSync(
  new URL("./__fixtures__/datadog-8041594.json", import.meta.url),
  "utf-8",
);

const MOZILLA_FIXTURE = readFileSync(new URL("./__fixtures__/mozilla-7947405.json", import.meta.url), "utf-8");

/** A fetch stand-in that records its calls and replays canned responses in order. */
function stubFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let next = 0;
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const canned = responses[Math.min(next++, responses.length - 1)];
    if (canned instanceof Error) throw canned;
    return canned;
  };
  return { impl, calls };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

describe("parseGreenhouseUrl", () => {
  it("parses a boards.greenhouse.io job URL", () => {
    expect(parseGreenhouseUrl("https://boards.greenhouse.io/anthropic/jobs/5304425008")).toEqual({
      board: "anthropic",
      jobId: "5304425008",
      boardGuessed: false,
    });
  });

  it("parses a job-boards.greenhouse.io job URL", () => {
    expect(parseGreenhouseUrl("https://job-boards.greenhouse.io/amplitude/jobs/8654510002")).toEqual({
      board: "amplitude",
      jobId: "8654510002",
      boardGuessed: false,
    });
  });

  it("tolerates a trailing slash and a query string on a job board URL", () => {
    expect(
      parseGreenhouseUrl("https://job-boards.greenhouse.io/amplitude/jobs/8654510002/?gh_src=linkedin"),
    ).toEqual({ board: "amplitude", jobId: "8654510002", boardGuessed: false });
  });

  it("takes the job id from gh_jid and the board from boardOverride without guessing", () => {
    expect(
      parseGreenhouseUrl("https://www.amplitude.com/careers/openings?gh_jid=8654510002", {
        boardOverride: "amplitude",
      }),
    ).toEqual({ board: "amplitude", jobId: "8654510002", boardGuessed: false });
  });

  it("guesses the board from companyHint, lowercasing it and stripping spaces and punctuation", () => {
    expect(
      parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=123", { companyHint: "Acme Corp, Inc." }),
    ).toEqual({ board: "acmecorpinc", jobId: "123", boardGuessed: true });
  });

  it("prefers an explicit boardOverride over companyHint", () => {
    expect(
      parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=123", {
        boardOverride: "acme",
        companyHint: "Acme Corp",
      }),
    ).toEqual({ board: "acme", jobId: "123", boardGuessed: false });
  });

  it("returns an error naming the missing board when gh_jid carries no board", () => {
    const result = parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=123");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/board/i);
  });

  it("returns an error when companyHint has nothing left after normalization", () => {
    const result = parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=123", { companyHint: "!!! ???" });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/board/i);
  });

  it("rejects a board slug outside /^[a-z0-9-]+$/", () => {
    expect(parseGreenhouseUrl("https://boards.greenhouse.io/Acme_Corp/jobs/123")).toHaveProperty("error");
    expect(
      parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=123", { boardOverride: "acme corp" }),
    ).toHaveProperty("error");
  });

  it("rejects a job id that is not all digits", () => {
    expect(parseGreenhouseUrl("https://boards.greenhouse.io/amplitude/jobs/abc")).toHaveProperty("error");
    expect(parseGreenhouseUrl("https://careers.acme.com/roles?gh_jid=12a", { boardOverride: "acme" })).toHaveProperty(
      "error",
    );
  });

  it("rejects a URL that is neither a Greenhouse board URL nor carries gh_jid", () => {
    const result = parseGreenhouseUrl("https://www.amplitude.com/careers/openings");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/gh_jid/);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(parseGreenhouseUrl("amplitude/jobs/8654510002")).toHaveProperty("error");
  });
});

describe("fetchJobSchema", () => {
  it("requests the board API with questions=true and the gatherer's headers", async () => {
    const { impl, calls } = stubFetch(new Response(AMPLITUDE_FIXTURE, { status: 200 }));
    await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://boards-api.greenhouse.io/v1/boards/amplitude/jobs/8654510002?questions=true",
    );
    expect(headerOf(calls[0].init, "Accept")).toBe("application/json");
    expect(headerOf(calls[0].init, "User-Agent")).toBe(UA);
  });

  it("returns the parsed job payload on a 200", async () => {
    const { impl } = stubFetch(new Response(AMPLITUDE_FIXTURE, { status: 200 }));
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result.ok).toBe(true);
    const raw = (result as { ok: true; raw: Record<string, unknown> }).raw;
    expect(raw.id).toBe(8654510002);
    expect(raw.title).toBe("Engineering Manager, Data Connections");
  });

  it("reports a 404 on a known board as a closed posting", async () => {
    const { impl } = stubFetch(
      new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 }),
    );
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, closed: true, status: 404 });
    expect((result as { needs_board_slug?: true }).needs_board_slug).toBeUndefined();
    expect((result as { error: string }).error).toMatch(/closed/i);
  });

  it("reports a 404 on a guessed board as a missing board slug, not a closed posting", async () => {
    const { impl } = stubFetch(
      new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 }),
    );
    const result = await fetchJobSchema("acmecorp", "123", { boardGuessed: true, fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, needs_board_slug: true, status: 404 });
    expect((result as { closed?: true }).closed).toBeUndefined();
    expect((result as { error: string }).error).toMatch(/board/i);
  });

  it("treats a Job-not-found body served with a 200 as the same not-found branch", async () => {
    const { impl } = stubFetch(
      new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 200 }),
    );
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, closed: true });
  });

  it("returns the status code on a server error", async () => {
    const { impl } = stubFetch(new Response("upstream exploded", { status: 500 }));
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toContain("500");
    expect((result as { closed?: true }).closed).toBeUndefined();
  });

  it("returns an error when the body is not JSON", async () => {
    const { impl } = stubFetch(new Response("<html>Cloudflare</html>", { status: 200 }));
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 200 });
    expect((result as { error: string }).error).toMatch(/json/i);
  });

  it("returns an error instead of throwing when the fetch itself fails", async () => {
    const { impl } = stubFetch(new Error("getaddrinfo ENOTFOUND"));
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("ENOTFOUND");
  });

  it("refuses a board or job id that would not survive validation, without fetching", async () => {
    const { impl, calls } = stubFetch(new Response(AMPLITUDE_FIXTURE, { status: 200 }));
    expect(await fetchJobSchema("amplitude/../evil", "123", { fetchImpl: impl })).toMatchObject({ ok: false });
    expect(await fetchJobSchema("amplitude", "123?x=1", { fetchImpl: impl })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  /**
   * M6. Without a deadline the request inherits Node's, which is effectively none: a board
   * that accepts the connection and never answers would hang the tool call. The signal has
   * to reach `fetch` itself, and the abort it causes has to come back as an ordinary
   * `{ ok: false }` — the never-throw contract is what every caller here is written against.
   */
  it("passes an abort signal to fetch and reports a timeout as an error rather than throwing", async () => {
    const { impl, calls } = stubFetch(new Response(AMPLITUDE_FIXTURE, { status: 200 }));
    await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl });
    const signal = calls[0].init?.signal;
    expect(signal, "fetch was called without a signal").toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    // What `AbortSignal.timeout` actually produces when it fires.
    const timedOut = new Error("The operation was aborted due to timeout");
    timedOut.name = "TimeoutError";
    const aborted = stubFetch(timedOut);
    const result = await fetchJobSchema("amplitude", "8654510002", { fetchImpl: aborted.impl });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("timeout");
    expect((result as { closed?: true }).closed).toBeUndefined();
  });

  it("aborts on the caller's own signal as well as on the deadline", async () => {
    const { impl, calls } = stubFetch(new Response(AMPLITUDE_FIXTURE, { status: 200 }));
    const caller = new AbortController();
    await fetchJobSchema("amplitude", "8654510002", { fetchImpl: impl, signal: caller.signal });
    const signal = calls[0].init?.signal;
    expect(signal?.aborted).toBe(false);
    caller.abort(new Error("the user stopped the turn"));
    expect(signal?.aborted).toBe(true);
  });

  it("returns an error instead of throwing when the caller's signal is already aborted", async () => {
    const { impl } = stubFetch(new DOMException("This operation was aborted", "AbortError"));
    const result = await fetchJobSchema("amplitude", "8654510002", {
      fetchImpl: impl,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/abort/i);
  });
});

describe("compactSchema", () => {
  const amplitude = compactSchema(JSON.parse(AMPLITUDE_FIXTURE));
  const anthropic = compactSchema(JSON.parse(ANTHROPIC_FIXTURE));
  const datadog = compactSchema(JSON.parse(DATADOG_FIXTURE));
  const mozilla = compactSchema(JSON.parse(MOZILLA_FIXTURE));

  /** Every question the compaction kept, by id, so a lookup reads as one expression. */
  function byId(schema: CompactSchema): Map<string, CompactQuestion> {
    return new Map(schema.questions.map((q) => [q.id, q]));
  }

  function idsFrom(schema: CompactSchema, source: CompactQuestion["source"]): string[] {
    return schema.questions.filter((q) => q.source === source).map((q) => q.id);
  }

  /** Ids the payload itself produced, without the location pair the compaction synthesises. */
  function payloadIds(schema: CompactSchema): string[] {
    return schema.questions.filter((q) => q.source !== "location").map((q) => q.id);
  }

  it("reads the title and company off both postings, trimming the company name", () => {
    // The amplitude payload's company_name is literally "Amplitude " with a trailing space.
    expect(amplitude.title).toBe("Engineering Manager, Data Connections");
    expect(amplitude.company).toBe("Amplitude");
    expect(anthropic.title).toBe("Staff Software Engineer, Labs: Applied AI");
    expect(anthropic.company).toBe("Anthropic");
  });

  it("compacts amplitude to 17 answerable fields and anthropic to 26", () => {
    // amplitude: 12 fields across 10 questions[] (two of them carry a text twin) + 5
    // demographic questions + no compliance. anthropic: 22 fields across 21 questions[]
    // (one text twin) + 4 compliance questions + no demographics. Neither board's
    // location_questions is populated, so neither gains a `candidate-location` question,
    // and no board gains a `country` question — the schema never synthesises one.
    expect(payloadIds(amplitude)).toHaveLength(17);
    expect(amplitude.questions).toHaveLength(17);
    expect(idsFrom(amplitude, "question")).toHaveLength(12);
    expect(idsFrom(amplitude, "compliance")).toHaveLength(0);
    expect(idsFrom(amplitude, "demographic")).toHaveLength(5);

    expect(payloadIds(anthropic)).toHaveLength(26);
    expect(anthropic.questions).toHaveLength(26);
    expect(idsFrom(anthropic, "question")).toHaveLength(22);
    expect(idsFrom(anthropic, "compliance")).toHaveLength(4);
    expect(idsFrom(anthropic, "demographic")).toHaveLength(0);
  });

  it("uses fields[].name as the id, so every id is a usable DOM element id", () => {
    expect(idsFrom(amplitude, "question")).toEqual([
      "first_name",
      "last_name",
      "preferred_name",
      "email",
      "phone",
      "resume",
      "resume_text",
      "cover_letter",
      "cover_letter_text",
      "question_37497949002",
      "question_37497950002",
      "question_37497992002",
    ]);
    for (const q of [...amplitude.questions, ...anthropic.questions, ...datadog.questions]) {
      expect(isValidElementId(q.id), q.id).toBe(true);
    }
  });

  it("keeps a multi-select whose field name carries the [] suffix, id and all", () => {
    // Greenhouse names a multi_value_multi_select field `question_<n>[]`, brackets and all,
    // and renders that whole string as the input's DOM id. Dropping it as unsafe cost the
    // live Datadog run a required question.
    const cities = datadog.questions.find((q) => q.id === "question_67918863[]");
    expect(cities).toMatchObject({
      type: "multi_value_multi_select",
      required: true,
      label: "In what cities are you available to work?",
    });
    expect(cities?.options?.length).toBe(45);
    expect(datadog.notes.filter((n) => n.includes("67918863"))).toEqual([]);
    for (const q of datadog.questions) expect(isValidElementId(q.id), q.id).toBe(true);
  });

  it("emits both halves of a file question and marks the text one as the twin", () => {
    const amp = byId(amplitude);
    expect(amp.get("resume")).toMatchObject({ type: "input_file", label: "Resume/CV" });
    expect(amp.get("resume")?.twinOf).toBeUndefined();
    expect(amp.get("resume_text")).toMatchObject({ type: "textarea", twinOf: "resume" });
    expect(amp.get("cover_letter")).toMatchObject({ type: "input_file", label: "Cover Letter" });
    expect(amp.get("cover_letter_text")).toMatchObject({ type: "textarea", twinOf: "cover_letter" });

    // anthropic asks for a resume the same way but has no cover-letter question at all.
    const ant = byId(anthropic);
    expect(ant.get("resume_text")).toMatchObject({ twinOf: "resume" });
    expect(ant.has("cover_letter")).toBe(false);
    expect(ant.has("cover_letter_text")).toBe(false);
  });

  it("carries the raw Greenhouse field type and required flag through unchanged", () => {
    const amp = byId(amplitude);
    expect(amp.get("first_name")).toMatchObject({ type: "input_text", required: true });
    expect(amp.get("preferred_name")).toMatchObject({ type: "input_text", required: false });
    expect(amp.get("question_37497992002")?.type).toBe("multi_value_single_select");
    expect(byId(anthropic).get("question_17082123008")).toMatchObject({
      type: "textarea",
      required: true,
      label: "Why Anthropic?",
    });
  });

  it("takes question option labels from values[].label, never from the numeric value", () => {
    const yesNo = byId(amplitude).get("question_37497992002");
    expect(yesNo?.options).toEqual(["Yes", "No"]);
    expect(yesNo?.declineOption).toBeUndefined();
    expect(byId(amplitude).get("first_name")?.options).toBeUndefined();
  });

  it("skips the compliance entry whose questions array is empty and keeps the rest", () => {
    // anthropic's compliance[] has four eeoc entries; the first carries only a public
    // burden statement and no questions.
    expect(idsFrom(anthropic, "compliance")).toEqual([
      "disability_status",
      "veteran_status",
      "race",
      "gender",
    ]);
    const race = byId(anthropic).get("race");
    expect(race).toMatchObject({ type: "multi_value_single_select", required: false, label: "Race" });
    // values[].value is a string on compliance and a number on questions[]; neither is used.
    expect(race?.options).toContain("Black or African American");
    expect(race?.options).not.toContain("3");
  });

  it("null-guards compliance on amplitude and demographic_questions on anthropic", () => {
    expect(JSON.parse(AMPLITUDE_FIXTURE).compliance).toBeNull();
    expect(JSON.parse(ANTHROPIC_FIXTURE).demographic_questions).toBeNull();
    expect(amplitude.questions.some((q) => q.source === "compliance")).toBe(false);
    expect(anthropic.questions.some((q) => q.source === "demographic")).toBe(false);
  });

  it("turns each demographic question's bare numeric id into a string id", () => {
    expect(idsFrom(amplitude, "demographic")).toEqual([
      "4001539002",
      "4001540002",
      "4001541002",
      "4001542002",
      "4001543002",
    ]);
    const gender = byId(amplitude).get("4001539002");
    expect(gender).toMatchObject({
      label: "Gender Identity",
      required: true,
      type: "multi_value_single_select",
      source: "demographic",
    });
    // Demographic options live under answer_options[], not values[].
    expect(gender?.options).toContain("Genderqueer");
  });

  it("gives every compliance and demographic question a non-empty declineOption", () => {
    const eeo = [...amplitude.questions, ...anthropic.questions].filter(
      (q) => q.source === "compliance" || q.source === "demographic",
    );
    expect(eeo).toHaveLength(9);
    for (const q of eeo) {
      expect(q.declineOption, `${q.id} has no declineOption`).toBeTruthy();
      expect(q.options).toContain(q.declineOption);
    }
    // The board's own wording, which the profile's generic "prefer not to answer" maps onto.
    expect(byId(amplitude).get("4001539002")?.declineOption).toBe("I don't wish to answer");
    expect(byId(anthropic).get("race")?.declineOption).toBe("Decline To Self Identify");
    expect(byId(anthropic).get("disability_status")?.declineOption).toBe("I do not want to answer");
  });

  it("never emits description HTML, content, or data_compliance", () => {
    for (const schema of [amplitude, anthropic]) {
      const json = JSON.stringify(schema);
      expect(json).not.toContain("<p>");
      expect(json).not.toContain("&lt;");
      expect(json).not.toContain("data_compliance");
      expect(json).not.toContain("PUBLIC BURDEN");
      expect(Object.keys(schema).sort()).toEqual(["company", "notes", "questions", "title"]);
      expect(schema.questions.every((q) => !("description" in q))).toBe(true);
    }
  });

  it("stays well under 6 KB when stringified", () => {
    expect(JSON.stringify(amplitude).length).toBeLessThan(6000);
    expect(JSON.stringify(anthropic).length).toBeLessThan(6000);
  });

  it("notes the absolute resume path", () => {
    for (const schema of [amplitude, anthropic]) {
      expect(schema.notes.some((n) => /absolute path/i.test(n))).toBe(true);
    }
  });

  it("turns location_questions into an answerable location combobox", () => {
    const q = mozilla.questions.find((x) => x.id === "candidate-location");
    expect(q).toEqual({
      id: "candidate-location",
      label: "Location (City)",
      type: "unlisted_select",
      required: true,
      source: "location",
    });
    // The API calls the field `location` and types it `input_text`; the DOM renders
    // `input#candidate-location[role=combobox]`. The id in the schema is the DOM's.
    expect(mozilla.questions.some((x) => x.id === "location")).toBe(false);
  });

  it("ignores the hidden longitude and latitude entries, which react-select holds in state", () => {
    for (const id of ["longitude", "latitude", "Longitude", "Latitude"]) {
      expect(mozilla.questions.some((x) => x.id === id)).toBe(false);
    }
  });

  it("never synthesises a country question: #country on the page is the phone widget's dial-code selector", () => {
    // The API describes no address-country field on any board, and the schema does not
    // invent one. `input#country[role=combobox]`, where it exists in the DOM, belongs to
    // the phone control: its only "United States" option reads "United States +1", and
    // picking it reformats `phone`. An earlier version of this adapter synthesised a
    // `country` question aimed at that control; it corrupted `phone` on every board live, so
    // it was removed. See the note above `compactLocationQuestions`.
    for (const [name, schema] of [["mozilla", mozilla], ["amplitude", amplitude], ["datadog", datadog], ["anthropic", anthropic]] as const) {
      expect(schema.questions.some((q) => q.id === "country"), name).toBe(false);
      expect(schema.notes.some((n) => /country/i.test(n)), name).toBe(false);
    }
  });

  it("says where the location question came from, and only when there is one", () => {
    expect(mozilla.notes.some((n) => n.includes("Location (City)"))).toBe(true);
    // datadog's location_questions is [], so it gets no location question and no note.
    expect(datadog.questions.some((x) => x.id === "candidate-location")).toBe(false);
    expect(datadog.notes.some((n) => n.includes("Location (City)"))).toBe(false);
  });

  it("counts up by exactly the one location question, and only where location_questions is populated", () => {
    expect(mozilla.questions).toHaveLength(32); // 31 plus candidate-location
    expect(datadog.questions).toHaveLength(20); // location_questions is [], so unchanged
  });

  it("drops a field whose name is not a safe id into notes and never makes it a question", () => {
    // The second payload closes a `[]` suffix the way a real multi-select id opens one, so
    // admitting `[]` cannot be widened into admitting whatever follows it.
    for (const evil of ['foo"]); await page.goto(', 'foo[]"]); await page.goto(']) {
      const result = compactSchema({
        title: "Injected",
        company_name: "Acme",
        questions: [{ label: "Anything", required: true, fields: [{ name: evil, type: "input_text", values: [] }] }],
        compliance: null,
        demographic_questions: null,
        location_questions: [],
      });
      expect(result.questions.filter((q) => q.source !== "location"), evil).toEqual([]);
      const dropped = result.notes.filter((n) => n.includes(evil));
      expect(dropped, evil).toHaveLength(1);
      expect(dropped[0]).toMatch(/dropped/i);
    }
  });

  it("keeps a hostile label as data without letting it near an id", () => {
    const result = compactSchema({
      title: "Injected",
      company_name: "Acme",
      questions: [
        {
          label: '"); await page.goto("https://evil.example',
          required: true,
          fields: [{ name: "question_1", type: "input_text", values: [] }],
        },
      ],
    });
    const kept = result.questions.filter((q) => q.source !== "location");
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("question_1");
    expect(kept[0].label).toBe('"); await page.goto("https://evil.example');
  });

  it("omits the file-upload gap note when the schema has no file upload", () => {
    const result = compactSchema({
      title: "Elsewhere",
      company_name: "Acme",
      questions: [{ label: "Referral Source", required: true, fields: [{ name: "referral_source", type: "input_text", values: [] }] }],
    });
    expect(result.questions.map((q) => q.id)).toEqual(["referral_source"]);
    expect(result.notes).toEqual([]);
  });

  it("drops a field whose type Greenhouse has not documented, with a note", () => {
    const result = compactSchema({
      title: "Odd",
      company_name: "Acme",
      questions: [
        { label: "Signature", required: true, fields: [{ name: "signature", type: "input_signature", values: [] }] },
        { label: "Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
      ],
    });
    expect(payloadIds(result)).toEqual(["first_name"]);
    expect(result.notes.some((n) => n.includes("input_signature"))).toBe(true);
  });

  it("returns an empty schema rather than throwing on a payload that is not an object", () => {
    for (const raw of [null, undefined, 42, "nope", [1, 2, 3]]) {
      const result = compactSchema(raw);
      expect(result.questions).toEqual([]);
      expect(result.title).toBe("");
      expect(result.company).toBe("");
      // Nothing was parsed, so there is no form to warn about either.
      expect(result.notes).toEqual([]);
    }
  });

  it("survives a payload whose question containers are the wrong shape", () => {
    const result = compactSchema({
      title: 7,
      company_name: null,
      questions: "not an array",
      compliance: [{ type: "eeoc", questions: null }, 5],
      demographic_questions: { questions: [{ id: {}, label: "Bad", type: "single_select", answer_options: [] }] },
    });
    expect(result.title).toBe("");
    expect(result.company).toBe("");
    // Nothing in the payload was answerable, and the schema synthesises no question of its own.
    expect(result.questions).toEqual([]);
  });
});

describe("isValidElementId", () => {
  it("accepts the ids both fixtures produce and rejects anything selector-unsafe", () => {
    for (const q of [...compactSchema(JSON.parse(AMPLITUDE_FIXTURE)).questions, ...compactSchema(JSON.parse(ANTHROPIC_FIXTURE)).questions]) {
      expect(isValidElementId(q.id), q.id).toBe(true);
    }
    for (const good of ["question_67918863[]", "resume", "4001539002", "first-name_2"]) {
      expect(isValidElementId(good), good).toBe(true);
    }
    // The `[]` suffix is admitted only whole, only once, and only at the end.
    for (const bad of ["", "a b", 'foo"]', "foo.bar", "foo#bar", "résumé", "foo[]bar", "foo[", "[]", "foo[]]", "foo[ ]", 'foo[]"]); await page.goto(', 42, null, undefined]) {
      expect(isValidElementId(bad), String(bad)).toBe(false);
    }
  });
});

describe("selectorFor", () => {
  const amplitude = compactSchema(JSON.parse(AMPLITUDE_FIXTURE));
  const anthropic = compactSchema(JSON.parse(ANTHROPIC_FIXTURE));
  const datadog = compactSchema(JSON.parse(DATADOG_FIXTURE));

  function question(schema: CompactSchema, id: string): CompactQuestion {
    const found = schema.questions.find((q) => q.id === id);
    if (found === undefined) throw new Error(`fixture has no question ${id}`);
    return found;
  }

  it("uses the attribute form for a bare-numeric demographic id", () => {
    // `document.querySelector('#4001539002')` throws: a CSS id may not start with a digit.
    expect(selectorFor(question(amplitude, "4001539002"))).toBe('input[id="4001539002"]');
  });

  it("uses the attribute form for a []-suffixed id, keeping the type qualifier", () => {
    // `#question_67918863[]` is not an id selector either: the brackets read as an
    // attribute selector of their own. Unlike a demographic id, the type still qualifies it.
    expect(selectorFor(question(datadog, "question_67918863[]"))).toBe('input[id="question_67918863[]"][role=combobox]');
    expect(selectorFor({ id: "x[]", label: "", type: "input_text", required: false, source: "question" })).toBe('input[id="x[]"]');
    expect(selectorFor({ id: "x[]", label: "", type: "textarea", required: false, source: "question" })).toBe('textarea[id="x[]"]');
    expect(selectorFor({ id: "x[]", label: "", type: "input_file", required: false, source: "question" })).toBe('input[id="x[]"][type=file]');
  });

  it("elementRef: #id for a plain identifier, the attribute form for anything else it accepts", () => {
    expect(elementRef("first_name")).toBe("#first_name");
    expect(elementRef("question_67918863[]")).toBe('[id="question_67918863[]"]');
    expect(elementRef("4001539002")).toBe('[id="4001539002"]');
    expect(() => elementRef('foo"]')).toThrow(/id/i);
  });

  it("groupRefFor: the checkbox group's name attribute, and nothing that could escape it", () => {
    // The `[]` suffix is part of the `name` a checkbox group shares, so it rides through whole.
    expect(groupRefFor("question_1[]")).toBe('input[type="checkbox"][name="question_1[]"]');
    expect(groupRefFor("skills")).toBe('input[type="checkbox"][name="skills"]');
    // `ELEMENT_ID_RE` admits no quote and no loose bracket, so nothing can close the attribute.
    for (const bad of ['foo"]', 'foo"]); await page.goto(', "foo[]bar", "foo]", "a b", "foo[]]"]) {
      expect(() => groupRefFor(bad), bad).toThrow(/id/i);
    }
  });

  it("targets the file input of a file question", () => {
    expect(selectorFor(question(amplitude, "resume"))).toBe("input#resume[type=file]");
    expect(selectorFor(question(anthropic, "resume"))).toBe("input#resume[type=file]");
  });

  it("targets the combobox input of a select question", () => {
    expect(selectorFor(question(amplitude, "question_37497992002"))).toBe(
      "input#question_37497992002[role=combobox]",
    );
    expect(selectorFor(question(anthropic, "race"))).toBe("input#race[role=combobox]");
    expect(
      selectorFor({ id: "skills", label: "Skills", type: "multi_value_multi_select", required: false, source: "question" }),
    ).toBe("input#skills[role=combobox]");
  });

  it("uses the tag name for text inputs and textareas", () => {
    expect(selectorFor(question(amplitude, "first_name"))).toBe("input#first_name");
    expect(selectorFor(question(amplitude, "resume_text"))).toBe("textarea#resume_text");
  });

  it("reaches an unlisted select as a combobox", () => {
    expect(selectorFor({ id: "candidate-location", label: "Location (City)", type: "unlisted_select", required: true, source: "location" }))
      .toBe("input#candidate-location[role=combobox]");
    expect(selectorFor({ id: "referral_source", label: "How did you hear about us?", type: "unlisted_select", required: false, source: "question" }))
      .toBe("input#referral_source[role=combobox]");
  });

  it("produces a non-empty selector for every question of all three fixtures", () => {
    for (const q of [...amplitude.questions, ...anthropic.questions, ...datadog.questions]) {
      expect(selectorFor(q).length, q.id).toBeGreaterThan(0);
    }
  });

  it("throws rather than building a selector out of an unsafe id", () => {
    expect(() =>
      selectorFor({
        id: 'foo"]); await page.goto(',
        label: "Injected",
        type: "input_text",
        required: true,
        source: "question",
      }),
    ).toThrow(/id/i);
  });
});

/** A one-off schema for cases neither fixture contains. */
function schemaOf(...questions: CompactQuestion[]): CompactSchema {
  return { title: "Test Role", company: "Acme", questions, notes: [] };
}

describe("buildAnswerTemplate", () => {
  const amplitude = compactSchema(JSON.parse(AMPLITUDE_FIXTURE));
  const anthropic = compactSchema(JSON.parse(ANTHROPIC_FIXTURE));

  it("keys answers and hints by exactly the schema's question ids", () => {
    for (const schema of [amplitude, anthropic]) {
      const template = buildAnswerTemplate(schema);
      const ids = schema.questions.map((q) => q.id).sort();
      expect(Object.keys(template.answers).sort()).toEqual(ids);
      expect(Object.keys(template.hints).sort()).toEqual(ids);
      expect(Object.values(template.answers).every((v) => v === "")).toBe(true);
    }
  });

  it("carries label, type and required on every hint", () => {
    for (const schema of [amplitude, anthropic]) {
      const { hints } = buildAnswerTemplate(schema);
      for (const q of schema.questions) {
        expect(hints[q.id]).toMatchObject({ label: q.label, type: q.type, required: q.required });
      }
    }
  });

  it("carries options, declineOption and twinOf only where the question has them", () => {
    const { hints } = buildAnswerTemplate(amplitude);
    expect(hints.question_37497992002).toEqual({
      label: amplitude.questions.find((q) => q.id === "question_37497992002")?.label,
      type: "multi_value_single_select",
      required: true,
      options: ["Yes", "No"],
    });
    expect(hints["4001539002"].declineOption).toBe("I don't wish to answer");
    expect(hints.resume_text.twinOf).toBe("resume");
    expect(hints.first_name).toEqual({ label: "First Name", type: "input_text", required: true });
    expect("options" in hints.first_name).toBe(false);
  });

  it("never leaks the source or the selector into what the model fills in", () => {
    const template = buildAnswerTemplate(anthropic);
    expect(JSON.stringify(template)).not.toContain("input#");
    expect(template.hints.race).not.toHaveProperty("source");
  });
});

describe("validateAnswers", () => {
  const amplitude = compactSchema(JSON.parse(AMPLITUDE_FIXTURE));
  const anthropic = compactSchema(JSON.parse(ANTHROPIC_FIXTURE));
  const datadog = compactSchema(JSON.parse(DATADOG_FIXTURE));

  /** A plausible complete answer set: every non-twin question answered acceptably. */
  function fullAnswers(schema: CompactSchema): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const q of schema.questions) {
      if (q.twinOf !== undefined) continue;
      if (q.options !== undefined) answers[q.id] = q.declineOption ?? q.options[0];
      else if (q.type === "input_file") answers[q.id] = "/abs/path/to/resume.pdf";
      else answers[q.id] = "An answer.";
    }
    return answers;
  }

  it("resolves a full answer set for both fixtures with a selector on every field", () => {
    for (const schema of [amplitude, anthropic]) {
      const answers = fullAnswers(schema);
      const result = validateAnswers(schema, answers);
      expect(result.errors).toEqual([]);
      expect(result.unanswered).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.resolved).toHaveLength(Object.keys(answers).length);
      const ids = new Set(schema.questions.map((q) => q.id));
      for (const answer of result.resolved) {
        expect(ids.has(answer.id), answer.id).toBe(true);
        expect(answer.selector.length, answer.id).toBeGreaterThan(0);
        expect(answer.value).not.toEqual("");
      }
    }
  });

  it("resolves a list answer on a []-suffixed multi-select to the attribute selector", () => {
    const template = buildAnswerTemplate(datadog);
    expect(Object.keys(template.answers)).toContain("question_67918863[]");
    const given = {
      ...Object.fromEntries(Object.keys(template.answers).map((k) => [k, ""])),
      first_name: "Jane",
      "question_67918863[]": ["Amsterdam", "Atlanta"],
    };
    const result = validateAnswers(datadog, given);
    const cities = result.resolved.find((a) => a.id === "question_67918863[]");
    expect(cities).toMatchObject({
      value: ["Amsterdam", "Atlanta"],
      selector: 'input[id="question_67918863[]"][role=combobox]',
    });
    expect(result.errors.filter((e) => e.includes("67918863"))).toEqual([]);
  });

  it("accepts any non-empty string for an unlisted select, since the schema lists no options", () => {
    const schema = compactSchema(JSON.parse(MOZILLA_FIXTURE));
    const r = validateAnswers(schema, { "candidate-location": "San Francisco" });
    expect(r.errors.filter((e) => e.includes("candidate-location"))).toEqual([]);
    const loc = r.resolved.find((a) => a.id === "candidate-location");
    expect(loc).toMatchObject({ type: "unlisted_select", value: "San Francisco" });
  });

  it("rejects a country answer: the schema has no such question", () => {
    // `country` is not in the schema — `input#country` on the page is the phone widget's
    // dial-code selector, not an address field — so an answer keyed by it is unknown.
    const schema = compactSchema(JSON.parse(MOZILLA_FIXTURE));
    const r = validateAnswers(schema, { country: "United States" });
    expect(r.errors.some((e) => /Unknown question `country`/.test(e))).toBe(true);
    expect(r.resolved.some((a) => a.id === "country")).toBe(false);
  });

  it("still refuses a blank answer to the required location question", () => {
    const schema = compactSchema(JSON.parse(MOZILLA_FIXTURE));
    const r = validateAnswers(schema, { "candidate-location": "" });
    expect(r.unanswered).toContain("candidate-location");
  });

  it("does not accept __decline__ for an unlisted select", () => {
    const schema = compactSchema(JSON.parse(MOZILLA_FIXTURE));
    const r = validateAnswers(schema, { "candidate-location": DECLINE_ANSWER });
    expect(r.errors.some((e) => e.includes("candidate-location"))).toBe(true);
  });

  it("copies the question's label, type and source onto the resolved answer", () => {
    const result = validateAnswers(amplitude, { first_name: "Ada", "4001539002": "Female" });
    expect(result.resolved).toEqual([
      {
        id: "first_name",
        label: "First Name",
        type: "input_text",
        source: "question",
        value: "Ada",
        selector: "input#first_name",
      },
      {
        id: "4001539002",
        label: "Gender Identity",
        type: "multi_value_single_select",
        source: "demographic",
        value: "Female",
        selector: 'input[id="4001539002"]',
      },
    ]);
  });

  it("rejects an option label that is a near miss, naming the valid labels", () => {
    const result = validateAnswers(amplitude, { ...fullAnswers(amplitude), question_37497992002: "yes" });
    expect(result.ok).toBe(false);
    expect(result.unanswered).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("question_37497992002");
    expect(result.errors[0]).toContain('"Yes"');
    expect(result.errors[0]).toContain('"No"');
    expect(result.resolved.some((a) => a.id === "question_37497992002")).toBe(false);
  });

  it("puts a required question with a missing or blank answer in unanswered, not errors", () => {
    const answers = fullAnswers(amplitude);
    delete answers.first_name;
    answers.last_name = "   ";
    // boundary: B10 — missing required identity pauses (no script while unanswered).
    const result = validateAnswers(amplitude, answers);
    expect(result.errors).toEqual([]);
    expect(result.unanswered).toEqual(["first_name", "last_name"]);
    expect(result.ok).toBe(false);
  });

  it("leaves an unanswered optional question out of everything", () => {
    const result = validateAnswers(amplitude, { ...fullAnswers(amplitude), phone: "" });
    expect(result.ok).toBe(true);
    expect(result.unanswered).toEqual([]);
    expect(result.resolved.some((a) => a.id === "phone")).toBe(false);
  });

  it("reports an id that is not in the schema as an unknown question", () => {
    const result = validateAnswers(amplitude, { ...fullAnswers(amplitude), question_999: "Yes" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/unknown/i);
    expect(result.errors[0]).toContain("question_999");
  });

  it("resolves a decline on an option question to that board's own wording", () => {
    for (const answer of ["Prefer not to answer", "prefer NOT to answer", "__decline__"]) {
      const result = validateAnswers(anthropic, { race: answer });
      expect(result.errors).toEqual([]);
      expect(result.resolved[0]).toMatchObject({ id: "race", value: "Decline To Self Identify" });
    }
    expect(validateAnswers(amplitude, { "4001539002": "__decline__" }).resolved[0].value).toBe(
      "I don't wish to answer",
    );
  });

  it("refuses to decline a question that offers no decline option", () => {
    const result = validateAnswers(anthropic, { question_17082119008: "Prefer not to answer" });
    expect(result.ok).toBe(false);
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("question_17082119008");
    expect(result.errors[0]).toContain('"Yes"');
    expect(validateAnswers(anthropic, { question_17082119008: "__decline__" }).ok).toBe(false);
  });

  it("takes an exact option label even when it reads like a decline", () => {
    const result = validateAnswers(anthropic, { race: "Decline To Self Identify", gender: "Female" });
    expect(result.errors).toEqual([]);
    expect(result.resolved.map((a) => a.value)).toEqual(["Decline To Self Identify", "Female"]);
  });

  it("rejects __decline__ on a question that has no options at all", () => {
    const result = validateAnswers(anthropic, { question_17082123008: "__decline__" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("question_17082123008");
  });

  it("rejects a list on anything but a multi_value_multi_select", () => {
    const result = validateAnswers(anthropic, { race: ["White", "Asian"], first_name: ["Ada"] });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    // Errors come out in schema order, not in whatever order the model wrote its keys.
    expect(result.errors[0]).toContain("first_name");
    expect(result.errors[1]).toContain("race");
    expect(result.resolved).toEqual([]);
  });

  it("widens a string on a multi_value_multi_select into a one-element list", () => {
    const schema = schemaOf({
      id: "question_1",
      label: "Which languages?",
      type: "multi_value_multi_select",
      required: true,
      source: "question",
      options: ["Go", "Rust", "TypeScript"],
    });
    expect(validateAnswers(schema, { question_1: "Rust" }).resolved[0]).toMatchObject({
      value: ["Rust"],
      selector: "input#question_1[role=combobox]",
    });
    const many = validateAnswers(schema, { question_1: ["Rust", " Go "] });
    expect(many.ok).toBe(true);
    expect(many.resolved[0].value).toEqual(["Rust", "Go"]);
    // A repeat would click the same option twice, which takes it back off.
    expect(validateAnswers(schema, { question_1: ["Rust", " Rust ", "Go"] }).resolved[0].value).toEqual([
      "Rust",
      "Go",
    ]);
  });

  it("carries the checkbox group a multi-select may have to fall back to, and only there", () => {
    // Some boards render a `[]` multi-select as a checkbox group rather than a react-select,
    // so every multi-select answer carries both selectors. Nothing else can be one.
    const schema = schemaOf(
      {
        id: "question_1[]",
        label: "How did you hear about us?",
        type: "multi_value_multi_select",
        required: false,
        source: "question",
        options: ["LinkedIn", "Glassdoor"],
      },
      {
        id: "question_2",
        label: "Authorized?",
        type: "multi_value_single_select",
        required: false,
        source: "question",
        options: ["Yes"],
      },
      { id: "first_name", label: "First Name", type: "input_text", required: false, source: "question" },
    );
    const { resolved } = validateAnswers(schema, {
      "question_1[]": ["LinkedIn"],
      question_2: "Yes",
      first_name: "Jane",
    });
    expect(resolved[0].groupSelector).toBe('input[type="checkbox"][name="question_1[]"]');
    expect(resolved[1].groupSelector).toBeUndefined();
    expect(resolved[2].groupSelector).toBeUndefined();
  });

  it("rejects a list entry that is not an option, and a list of non-strings", () => {
    const schema = schemaOf({
      id: "question_1",
      label: "Which languages?",
      type: "multi_value_multi_select",
      required: true,
      source: "question",
      options: ["Go", "Rust"],
    });
    expect(validateAnswers(schema, { question_1: ["Rust", "COBOL"] }).errors[0]).toContain("COBOL");
    expect(validateAnswers(schema, { question_1: ["Rust", 7] }).errors[0]).toMatch(/string/i);
    expect(validateAnswers(schema, { question_1: [] }).unanswered).toEqual(["question_1"]);
  });

  it("refuses a decline mixed with real labels on a multi-select, but takes it on its own", () => {
    const schema = schemaOf({
      id: "race",
      label: "Race",
      type: "multi_value_multi_select",
      required: false,
      source: "compliance",
      options: ["White", "Asian", "Decline To Self Identify"],
      declineOption: "Decline To Self Identify",
    });

    // Ticking both submits a self-identification and a refusal to self-identify at once.
    const mixed = validateAnswers(schema, { race: ["White", "__decline__"] });
    expect(mixed.ok).toBe(false);
    expect(mixed.errors).toHaveLength(1);
    expect(mixed.errors[0]).toContain("Decline To Self Identify");
    expect(mixed.errors[0]).toContain("White");
    expect(mixed.resolved).toEqual([]);
    // The board's own wording spelled out is the same mix, and blocks the same way.
    expect(validateAnswers(schema, { race: ["White", "Decline To Self Identify"] }).ok).toBe(false);

    // A decline on its own still resolves to the board's wording, as a one-element list.
    const alone = validateAnswers(schema, { race: ["__decline__"] });
    expect(alone.ok).toBe(true);
    expect(alone.errors).toEqual([]);
    expect(alone.resolved[0].value).toEqual(["Decline To Self Identify"]);
    expect(validateAnswers(schema, { race: "__decline__" }).resolved[0].value).toEqual([
      "Decline To Self Identify",
    ]);
    // The same decline twice is one tick, not a mix.
    expect(
      validateAnswers(schema, { race: ["__decline__", "Decline To Self Identify"] }).resolved[0].value,
    ).toEqual(["Decline To Self Identify"]);
  });

  it("rejects a value that is neither a string nor a list", () => {
    const result = validateAnswers(amplitude, { first_name: 7, last_name: { v: "x" }, email: null });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toMatch(/number/);
    expect(result.errors[1]).toMatch(/object/);
    expect(result.errors[2]).toMatch(/null/);
  });

  it("drops a twin answered alongside its file parent and keeps the parent, with a note", () => {
    const result = validateAnswers(amplitude, {
      resume: "/abs/path/to/resume.pdf",
      resume_text: "Pasted resume text.",
      ...fullAnswers(amplitude),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.resolved.some((a) => a.id === "resume")).toBe(true);
    expect(result.resolved.some((a) => a.id === "resume_text")).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("resume_text");
    expect(result.notes[0]).toContain("resume");
  });

  it("keeps a twin answered on its own, when the file parent is left empty", () => {
    const result = validateAnswers(amplitude, { resume: "", resume_text: "Pasted resume text." });
    expect(result.notes).toEqual([]);
    expect(result.resolved.map((a) => a.id)).toEqual(["resume_text"]);
    expect(result.resolved[0].selector).toBe("textarea#resume_text");
  });

  it("takes a file answer as an opaque path string without touching the disk", () => {
    const result = validateAnswers(amplitude, { resume: "  /abs/path/to/resume.pdf  " });
    expect(result.errors).toEqual([]);
    expect(result.resolved[0]).toMatchObject({
      id: "resume",
      value: "/abs/path/to/resume.pdf",
      selector: "input#resume[type=file]",
    });
  });

  it("reports duplicate ids instead of resolving one of the two questions", () => {
    const schema = schemaOf(
      { id: "gender", label: "Gender", type: "input_text", required: true, source: "question" },
      { id: "gender", label: "Gender", type: "multi_value_single_select", required: false, source: "compliance", options: ["Female", "Male"] },
      { id: "first_name", label: "First Name", type: "input_text", required: true, source: "question" },
    );
    const result = validateAnswers(schema, { gender: "Female", first_name: "Ada" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gender");
    expect(result.resolved.map((a) => a.id)).toEqual(["first_name"]);
    expect(result.unanswered).toEqual([]);
  });

  it("reports a select that carries no options rather than crashing on it", () => {
    const schema = schemaOf({
      id: "question_1",
      label: "Pick one",
      type: "multi_value_single_select",
      required: true,
      source: "question",
    });
    const result = validateAnswers(schema, { question_1: "Yes" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no options/i);
    expect(result.resolved).toEqual([]);
  });

  it("never guesses: an empty answers object leaves every required question unanswered", () => {
    const result = validateAnswers(anthropic, {});
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.unanswered).toEqual(anthropic.questions.filter((q) => q.required).map((q) => q.id));
    expect(result.ok).toBe(false);
  });

  it("survives an answers value that is not an object at all", () => {
    for (const answers of [null, undefined, "nope", [1, 2]] as unknown as Array<Record<string, unknown>>) {
      const result = validateAnswers(schemaOf(), answers);
      expect(result).toEqual({ ok: true, resolved: [], unanswered: [], errors: [], notes: [] });
    }
  });

  it("keeps an enormous option list out of the error it writes", () => {
    const result = validateAnswers(amplitude, { "4001540002": "Klingon" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].length).toBeLessThan(500);
    expect(result.errors[0]).toContain("Klingon");
  });

  /**
   * I1. "Resume/CV" is one question rendered as two required elements — the upload and the
   * `_text` textarea behind "Enter manually" — and either one answers it. Reporting the empty
   * half as `unanswered` deadlocks the caller: `prepare_fill` writes no script while anything
   * is unanswered, so answering the file would demand the text and answering the text would
   * demand the file. Both halves are `required: true` here, which is how Greenhouse marks
   * them, so the pair is the only thing that can tell them apart.
   */
  describe("a required file question and its required text twin", () => {
    const pair = schemaOf(
      { id: "resume", label: "Resume/CV", type: "input_file", required: true, source: "question" },
      {
        id: "resume_text",
        label: "Resume/CV",
        type: "textarea",
        required: true,
        source: "question",
        twinOf: "resume",
      },
    );

    it("leaves the twin out of unanswered when its file parent is answered", () => {
      const result = validateAnswers(pair, { resume: "/abs/resume.pdf" });
      expect(result.unanswered).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.resolved.map((a) => a.id)).toEqual(["resume"]);
    });

    it("leaves the file parent out of unanswered when its twin is answered", () => {
      const result = validateAnswers(pair, { resume_text: "Ada Lovelace, Analytical Engines." });
      expect(result.unanswered).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.resolved.map((a) => a.id)).toEqual(["resume_text"]);
    });

    it("still reports both when neither half is answered", () => {
      const result = validateAnswers(pair, {});
      expect(result.unanswered).toEqual(["resume", "resume_text"]);
      expect(result.ok).toBe(false);
    });

    it("still reports both when the answer given is blank rather than absent", () => {
      const result = validateAnswers(pair, { resume: "", resume_text: "   " });
      expect(result.unanswered).toEqual(["resume", "resume_text"]);
      expect(result.ok).toBe(false);
    });

    it("carries twinOf onto the resolved twin, so the fill script knows to click Enter manually", () => {
      const result = validateAnswers(pair, { resume_text: "Ada Lovelace." });
      expect(result.resolved[0].twinOf).toBe("resume");
      // The parent is not a twin of anything, so it never carries the field.
      expect(validateAnswers(pair, { resume: "/abs/r.pdf" }).resolved[0].twinOf).toBeUndefined();
    });
  });
});

// ── Generated-script helpers ──
//
// The MCP evaluates a generated script as `(<source>)` inside a vm context whose only
// globals are `page` and an internal handle, so these stand in for that sandbox.

/**
 * Split a generated source into its one-line `const data = …;` literal and everything else.
 *
 * Every assertion about what the script *does* runs against the template half, because the
 * data half is attacker-controlled by construction: a real Greenhouse label reads "Do you
 * require sponsorship?" and a real answer can hold any text at all, so tokens that would be
 * a bug in the code are ordinary content inside the JSON.
 */
function splitScript(src: string): { data: string; template: string } {
  const lines = src.split("\n");
  const data = lines.filter((line) => line.startsWith("const data = "));
  expect(data.length, "generated source must hold at most one `const data = ` line").toBeLessThan(2);
  return { data: data[0] ?? "", template: lines.filter((line) => !line.startsWith("const data = ")).join("\n") };
}

/**
 * Naming any of these would be a reference to a global the vm context does not have.
 *
 * Matched as whole identifiers rather than as substrings, which is both stricter and more
 * accurate: stricter because a bare `window` is caught as well as `window.`, and accurate
 * because `otp_required` is a state name that happens to spell `require` inside itself.
 */
const SANDBOX_FORBIDDEN = [
  /\brequire\b/,
  /\bconsole\b/,
  /\bsetTimeout\b/,
  /\bprocess\b/,
  /\bBuffer\b/,
  /\bdocument\b/,
  /\bwindow\b/,
  /\bfetch\b/,
  /\bglobalThis\b/,
  /\beval\b/,
];

/**
 * Playwright calls whose signature takes a `timeout`. The MCP's ambient action timeout is
 * 30 s, so every occurrence of one of these in a template has to pass an explicit one.
 */
const WAITING_CALLS = [
  "click",
  "elementHandle",
  "waitForFunction",
  "fill",
  "setInputFiles",
  "innerText",
  "inputValue",
  "getAttribute",
  "pressSequentially",
  "waitFor",
  "isVisible",
  // Decision 15. A bare `isChecked()` on a box that has detached would eat most of the fill's
  // 30 s deadline on its own, which is the whole reason this list exists.
  "check",
  "isChecked",
];

/**
 * Members of `page` — and of `root`, the frame or page a template resolved — that the
 * templates may touch. `locator`, `getByRole` and `keyboard` build something rather than act,
 * `waitForTimeout` *is* a timeout, `frames` and `mainFrame` read a local array, and `title`
 * and `url` take no options, so none of them carries one. Anything else — `page.evaluate`
 * above all — fails here, which is what keeps the timeout rule below from rotting as the
 * templates change.
 */
const ALLOWED_PAGE_MEMBERS = [
  "locator",
  "getByRole",
  "keyboard",
  "waitForTimeout",
  "title",
  "url",
  "frames",
  "mainFrame",
  // Decision 13. The one page function any template runs, and it is on the allowlist rather
  // than an exception to it, under a rule `expectSandboxSafe` enforces rather than describes:
  // every `waitForFunction` call site passes a single inline arrow function that assigns
  // nothing, names neither `document` nor `window`, dispatches no event and interpolates
  // nothing — a read of DOM state and no more — and it is called on `root`, never on `page`.
  // `evaluate` stays forbidden on every receiver the templates control, which is the rule
  // that ban was written for.
  "waitForFunction",
];

/** The arguments of every `.<method>(…)` call in `src`, matched by balancing parens. */
function argsOfCalls(src: string, method: string): string[] {
  const needle = `.${method}(`;
  const found: string[] = [];
  let at = src.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    found.push(src.slice(at + needle.length, i));
    at = src.indexOf(needle, i);
  }
  return found;
}

/** Every sandbox rule that holds for all three generators, asserted in one place. */
function expectSandboxSafe(src: string): void {
  const { template } = splitScript(src);
  expect(() => new Function(`return ${src}`)).not.toThrow();
  for (const token of SANDBOX_FORBIDDEN) expect(template, String(token)).not.toMatch(token);
  // `evaluate` on anything the template holds a handle to as a document: a page function that
  // sets values and fires synthetic events is what `apply-altana.js` got wrong. Reading DOM
  // state through `waitForFunction`, or through an element handle, is a different thing.
  for (const forbidden of ["page.evaluate", "root.evaluate", "r.evaluate"]) {
    expect(template, forbidden).not.toContain(forbidden);
  }
  // Both handles are scanned: since Decision 12 most locators hang off `root`, which is the
  // embed frame on a company-hosted board, and a `root.evaluate` would be just as fatal.
  for (const match of template.matchAll(/\b(?:page|root)\.([A-Za-z]+)/g)) {
    expect(ALLOWED_PAGE_MEMBERS, match[0]).toContain(match[1]);
  }
  for (const method of WAITING_CALLS) {
    for (const args of argsOfCalls(template, method)) {
      expect(args, `.${method}(${args})`).toContain("timeout:");
    }
  }
  // The read-only rule the `waitForFunction` allowance is granted under, mechanically. A page
  // function that only reads cannot do what the `page.evaluate` ban exists to stop.
  expect(template).not.toContain("page.waitForFunction");
  for (const args of argsOfCalls(template, "waitForFunction")) {
    expect(args.trimStart(), args).toMatch(/^\([A-Za-z_$][\w$]*\) => /);
    for (const forbidden of ["dispatchEvent", "document", "window", "${"]) {
      expect(args, `waitForFunction(${forbidden})`).not.toContain(forbidden);
    }
    // Every `=` in the callback has to be part of a comparison or an arrow, never an
    // assignment: a page function that writes is not a read of DOM state.
    expect(args.replace(/=>|===|!==|==/g, ""), `assignment in waitForFunction(${args})`).not.toContain("=");
  }
  // A body that falls off the end returns `undefined`, and the model gets no result block.
  expect(template).toContain("catch (e) {");
  expect(template.trimEnd().endsWith("}")).toBe(true);
}

/**
 * The wordings a Greenhouse success page is recognised by. Broad on purpose: missing a real
 * confirmation costs a duplicate application, because the caller re-runs anything that did
 * not reach `submitted`.
 */
const CONFIRMED_WORDINGS =
  "thank(?:s| you) for applying|received your application|application (?:(?:has been|was) (?:received|submitted)|submitted)|successfully submitted|we'll be in touch";

/** The string a hostile model or a hostile board could put in a label, a value or an id. */
const INJECTION = `"); await page.goto('evil`;

/**
 * The job every generated script under test is written for (amplitude's, from the fixture).
 * Ruling P: each script refuses to touch a page whose URL does not carry it, so the fake
 * page below serves a URL that does — a scenario proves the guard by overriding that.
 */
const JOB = "8654510002";

function answer(over: Partial<ResolvedAnswer> & Pick<ResolvedAnswer, "id">): ResolvedAnswer {
  const type = over.type ?? "input_text";
  const built: ResolvedAnswer = {
    id: over.id,
    label: over.label ?? "A Question",
    type,
    source: over.source ?? "question",
    value: over.value ?? (type === "multi_value_multi_select" ? ["Yes"] : "An answer."),
    selector: over.selector ?? selectorFor({ id: over.id, label: "", type, required: false, source: "question" }),
  };
  // Mirrors `validateAnswers`, which gives every multi-select the checkbox group it may have
  // to fall back to: a fill scenario is then driven by the data a real run would carry.
  if (type === "multi_value_multi_select") built.groupSelector = over.groupSelector ?? groupRefFor(over.id);
  // Only ever set when the caller asks for it: an absent `twinOf` and one explicitly set to
  // undefined mean the same thing to the generator, and it must not appear in the data.
  if (over.twinOf !== undefined) built.twinOf = over.twinOf;
  return built;
}

/** Shape 1: nothing but text inputs and a textarea. */
const TEXT_ONLY: ResolvedAnswer[] = [
  answer({ id: "first_name", label: "First Name", value: "Jane" }),
  answer({ id: "last_name", label: "Last Name", value: "Placeholder" }),
  answer({ id: "cover_letter_text", label: "Cover Letter", type: "textarea", value: "A cover letter." }),
];

/** Shape 2: text, the resume file, and one single select. */
const TEXT_FILE_SELECT: ResolvedAnswer[] = [
  answer({ id: "first_name", label: "First Name", value: "Jane" }),
  answer({ id: "resume", label: "Resume/CV", type: "input_file", value: "/ignored/by/the/script.pdf" }),
  answer({
    id: "question_37497992002",
    label: "Are you authorized to work in the US?",
    type: "multi_value_single_select",
    value: "Yes",
  }),
];

/** Shape 3: text, a bare-numeric demographic id, and one multi select. */
const TEXT_DEMOGRAPHIC_MULTI: ResolvedAnswer[] = [
  answer({ id: "first_name", label: "First Name", value: "Jane" }),
  answer({
    id: "4001539002",
    label: "Gender",
    type: "multi_value_single_select",
    source: "demographic",
    value: "I don't wish to answer",
  }),
  answer({
    id: "question_9",
    label: "Which languages do you speak?",
    type: "multi_value_multi_select",
    value: ["Ada", "Erlang"],
  }),
];

describe("generateFillScript", () => {
  it("emits a sandbox-safe script for a text-only answer set", () => {
    const src = generateFillScript(TEXT_ONLY, "/abs/resume.pdf", JOB);
    expectSandboxSafe(src);
    expect(src.startsWith("async (page) => {\nconst data = ")).toBe(true);
    const { data } = splitScript(src);
    expect(data).toContain('"selector":"input#first_name"');
    expect(data).toContain('"selector":"textarea#cover_letter_text"');
    expect(data).toContain('"resumePath":"/abs/resume.pdf"');
  });

  it("emits a sandbox-safe script for text, a file and a single select", () => {
    const src = generateFillScript(TEXT_FILE_SELECT, "/abs/resume.pdf", JOB);
    expectSandboxSafe(src);
    const { data, template } = splitScript(src);
    expect(data).toContain('"selector":"input#resume[type=file]"');
    expect(data).toContain('"selector":"input#question_37497992002[role=combobox]"');
    // The resume field, and only it, uploads the caller's path rather than the model's.
    expect(template).toContain('const p = a.id === "resume" ? data.resumePath : a.value;');
    expect(template).toContain("await el.setInputFiles(p, { timeout: 5000 });");
    // The react-select keyboard dance, not a synthetic input event: poll for the menu, then
    // Tab alone — an ArrowDown would move off the option react-select already focused.
    expect(template).toContain(
      'for (let w = 0; w < 8 && !(await root.locator(".select__option").count()); w++) { if (over()) break; await page.waitForTimeout(250); }',
    );
    expect(template).toContain('await page.keyboard.press("Tab");');
    expect(template).toContain(".select__single-value");
  });

  it("reaches a bare-numeric demographic id through the attribute form only", () => {
    const src = generateFillScript(TEXT_DEMOGRAPHIC_MULTI, "/abs/resume.pdf", JOB);
    expectSandboxSafe(src);
    const { data, template } = splitScript(src);
    expect(data).toContain('input[id=\\"4001539002\\"]');
    // `document.querySelector('#4001539002')` throws: a CSS id may not start with a digit.
    expect(src).not.toContain("#4001539002");
    expect(template).toContain(".select__multi-value__label");
  });

  it("carries a []-suffixed id and its attribute selector as data, sandbox-safe", () => {
    const src = generateFillScript(
      [answer({ id: "question_67918863[]", label: "Cities", type: "multi_value_multi_select", value: ["Amsterdam"] })],
      "/abs/resume.pdf",
      JOB,
    );
    expectSandboxSafe(src);
    const { data } = splitScript(src);
    expect(data).toContain('input[id=\\"question_67918863[]\\"][role=combobox]');
    // And the checkbox group the same question falls back to when no react-select is rendered.
    expect(data).toContain('input[type=\\"checkbox\\"][name=\\"question_67918863[]\\"]');
  });

  it("builds a twin's file selector through elementRef", () => {
    const src = generateFillScript([answer({ id: "resume_text", label: "Resume/CV", type: "textarea", value: "text", twinOf: "resume" })], "/r.pdf", JOB);
    expect(splitScript(src).data).toContain('"twinFile":"input#resume[type=file]"');
  });

  it("keeps a value that reads like code inside the data literal", () => {
    const src = generateFillScript([answer({ id: "first_name", label: "First Name", value: INJECTION })], "/r.pdf", JOB);
    expectSandboxSafe(src);
    expect(src.split(INJECTION)).toHaveLength(2);
    const { data } = splitScript(src);
    expect(data).toContain(INJECTION);
    expect(src.indexOf(INJECTION)).toBeGreaterThan(src.indexOf("const data = "));
    expect(src.indexOf(INJECTION)).toBeLessThan(src.indexOf("const data = ") + data.length);
  });

  it("keeps a label that reads like code inside the data literal", () => {
    const src = generateFillScript([answer({ id: "first_name", label: INJECTION, value: "Jane" })], "/r.pdf", JOB);
    expectSandboxSafe(src);
    expect(src.split(INJECTION)).toHaveLength(2);
    expect(splitScript(src).data).toContain(INJECTION);
  });

  it("keeps a resume path that reads like code inside the data literal", () => {
    const src = generateFillScript(TEXT_ONLY, `/tmp/${INJECTION}.pdf`, JOB);
    expectSandboxSafe(src);
    expect(src.split(INJECTION)).toHaveLength(2);
    expect(splitScript(src).data).toContain(INJECTION);
  });

  it("throws rather than emitting a script built on a selector-unsafe id", () => {
    // Built by hand rather than through `answer()`: that helper calls `selectorFor`, which
    // throws on an unsafe id before the generator is ever reached, so the test would pass
    // whether or not the generator carried a guard of its own. Task 5 rejects these ids
    // upstream; this asserts the defensive half of the same rule, by its own message.
    for (const id of ['foo"]); await page.goto(', 'foo[]"]); await page.goto(']) {
      const unsafe: ResolvedAnswer = {
        id,
        label: "Injected",
        type: "input_text",
        source: "question",
        value: "Jane",
        selector: "input#first_name",
      };
      expect(() => generateFillScript([unsafe], "/r.pdf", JOB), id).toThrow(/Refusing to generate a fill script for id/);
    }
  });

  it("leaves a label spelling out every forbidden token harmless inside the data literal", () => {
    // Nothing in a label is a token, because a label is never anything but a JSON string.
    const label = "require console.log setTimeout process.exit Buffer document.body window.top";
    const src = generateFillScript([answer({ id: "first_name", label, value: "Jane" })], "/r.pdf", JOB);
    expectSandboxSafe(src);
    expect(splitScript(src).data).toContain(label);
  });

  it("generates a sandbox-safe script from a real board's resolved answers", () => {
    const amplitude = compactSchema(JSON.parse(AMPLITUDE_FIXTURE));
    const answers: Record<string, string> = {};
    for (const q of amplitude.questions) {
      if (q.twinOf !== undefined) continue;
      if (q.options !== undefined) answers[q.id] = q.declineOption ?? q.options[0];
      else if (q.type === "input_file") answers[q.id] = "/abs/resume.pdf";
      else answers[q.id] = "Jane Placeholder";
    }
    const resolved = validateAnswers(amplitude, answers).resolved;
    expect(resolved.length).toBeGreaterThan(10);
    const src = generateFillScript(resolved, "/abs/resume.pdf", JOB);
    expectSandboxSafe(src);
    for (const a of resolved) expect(splitScript(src).data, a.id).toContain(JSON.stringify(a.selector).slice(1, -1));
  });

  it("stays small enough to echo back into context on every call", () => {
    // The MCP echoes the whole source after every call, so only the data literal may grow
    // with the form: the template is fixed, and subtracting the data measures it.
    //
    // Decision 12 raised the cap from 3,072 B to 4,096 B for the frame-aware root, the
    // anchor and the deadlines; Decision 13 raised the fill's alone to 5,120 B for the settle,
    // the confirm-after-fill pass and the "not on page" check — about +85 tokens per fill call
    // against a 6M baseline. Decision 14 raised the fill's again to 5,376 B for the upload
    // retry and the error text it quotes. Decision 15 raised the fill's again to 5,888 B for
    // the menu-aware select dance and the location and checkbox-group branches that follow it
    // — about +128 tokens per fill call against the same baseline. Decision 16 raised the
    // fill's a last time to 6,144 B, once those two branches were written and measured rather
    // than estimated: the checkbox-group fallback and the unlisted-select read-back fork cost
    // 256 B more than Decision 15 had budgeted, about +64 tokens per fill call on top of it,
    // and they buy the three required fields a board like Twilio 8108771 renders as
    // checkboxes — fields that were otherwise hand-driven at tens of browser round trips
    // each, orders of magnitude more context than the raise costs. That is the ceiling: the
    // fill template has no room left, and the next capability that would grow it needs a
    // different mechanism, not another raise. Submit keeps 4,125 (PJR-15 pre-submit via
    // `confirmed()`); OTP keeps 4,096.
    const empty = generateFillScript([], "", JOB);
    expect(empty.length - splitScript(empty).data.length).toBeLessThan(6144);
    const twenty = Array.from({ length: 20 }, (_, i) => answer({ id: `question_${i}`, label: `Question ${i}` }));
    const src = generateFillScript(twenty, "/abs/resume.pdf", JOB);
    expect(src.length - splitScript(src).data.length).toBeLessThan(6144);
    const submit = generateSubmitScript(JOB);
    expect(submit.length - splitScript(submit).data.length).toBeLessThan(4126);
    const otp = generateOtpScript("BMCHFZGE", JOB);
    expect(otp.length - splitScript(otp).data.length).toBeLessThan(4096);
  });

  /**
   * Ruling L, pinned in `npm test` rather than only in the dry-run harness: the fill script
   * has no business touching a button, and "Submit application" is the accessible name of
   * the one button that would end the application. `scripts/greenhouse-dryrun.mjs` aborts
   * before opening a browser on the same three needles; this is the copy that runs on every
   * commit, so a fill template that grows a submit affordance fails here first.
   */
  it("emits no submit affordance for any answer shape", () => {
    for (const [name, shape] of [
      ["text only", TEXT_ONLY],
      ["text, file and a single select", TEXT_FILE_SELECT],
      ["text, a demographic and a multi select", TEXT_DEMOGRAPHIC_MULTI],
    ] as const) {
      const src = generateFillScript(shape, "/abs/resume.pdf", JOB);
      for (const needle of ["Submit application", 'getByRole("button"', "getByRole('button'"]) {
        expect(src, `${name}: ${needle}`).not.toContain(needle);
      }
    }
  });
});

describe("generateSubmitScript", () => {
  const src = generateSubmitScript(JOB);

  it("emits a sandbox-safe script whose only data is the job it belongs to", () => {
    expectSandboxSafe(src);
    expect(splitScript(src).data).toBe(`const data = {"jobId":"${JOB}"};`);
  });

  it("checks for a CAPTCHA before it clicks and again after", () => {
    expect(src).toContain('iframe[src*="hcaptcha"]');
    expect(src).toContain('iframe[src*="recaptcha"][src*="bframe"]');
    expect(src).toContain('iframe[src*="turnstile"]');
    expect(src).toContain("verify you are human|verifying you're human|press and hold");
    expect(src.split("await seesCaptcha(")).toHaveLength(3);
    expect(src.indexOf("seesCaptcha(before)")).toBeLessThan(src.indexOf("Submit application"));
  });

  it("clicks exactly one button, by its accessible name", () => {
    expect(src).toContain('await root.getByRole("button", { name: "Submit application" }).click({ timeout: 5000 });');
    expect(src.split('.click({ timeout: 5000 })')).toHaveLength(2);
  });

  it("returns one of the five states on every path", () => {
    for (const state of ["captcha", "otp_required", "submitted", "validation_errors", "unknown", "error"]) {
      expect(src, state).toContain(`state: "${state}"`);
    }
    expect(src).toContain('input[maxlength="1"]');
    expect(src).toContain("security code");
    expect(src).toContain(CONFIRMED_WORDINGS);
    expect(src).toContain('[aria-invalid="true"], .field-error, form [role="alert"]');
    // A bare `.error` or a page-level `[role="alert"]` also matches a "Saving your answers"
    // live region, and the answer to `validation_errors` is to re-submit.
    expect(src).not.toContain('.error, [role="alert"]');
    // `submitted` needs a positive signal; the form being gone is not one.
    expect(src).toContain('if (await confirmed(body, preConfirmed, vanished)) return { state: "submitted" };');
    expect(src).not.toContain('buttons === 0 && forms === 0) return { state: "submitted" }');
    // Both documents: an embedded board's parent navigates while the iframe is torn down.
    expect(src).toContain('if (String(page.url()).indexOf("/confirmation") > -1) return true;');
    expect(src).toContain('if (root !== page && String(root.url()).indexOf("/confirmation") > -1) return true;');
    // The CAPTCHA check runs ahead of every success predicate in the tick.
    expect(src.indexOf("await seesCaptcha(body)")).toBeLessThan(src.indexOf("await confirmed(body,"));
    // Validation errors are not believed until the page has had time to settle.
    expect(src).toContain("if (i >= 2) {");
    // A missing form is latched, not returned on: the confirmation may still be a tick away,
    // and the latch is read by `confirmed` on the very next line.
    expect(src).toContain('if (!(await root.locator("button[type=submit], form").count())) vanished = true;');
    expect(src.indexOf("vanished = true;")).toBeLessThan(src.indexOf("await confirmed(body,"));
  });

  /**
   * C2: the wording branch is only evidence if the wording was not already on the page. A
   * job description that says "we'll be in touch" would otherwise turn a click that did
   * nothing into `submitted`, which is terminal — the queue entry moves and is never retried.
   */
  it("takes a confirmation-wording baseline before it clicks", () => {
    expect(src).toContain("const preConfirmed = confirmedText(before);");
    expect(src.indexOf("const preConfirmed")).toBeLessThan(src.indexOf("Submit application"));
    expect(src).toContain("if (confirmedText(body) && (!pre || gone)) return true;");
  });

  /** Ruling P: the guard is the first thing in the body, ahead of every locator. */
  it("refuses to run anywhere but on the job it was written for", () => {
    expect(src).toContain(
      `!new RegExp("(/jobs/|gh_jid=|token=)" + data.jobId + "(?!\\\\d)").test(page.url() + " " + root.url())`,
    );
    expect(src).toContain('detail: "wrong page: expected job " + data.jobId');
    expect(src.indexOf("gh_jid=")).toBeLessThan(src.indexOf("root.locator"));
  });

  it("polls in half-second steps, and no further than its own wall-clock deadline", () => {
    expect(src).toContain("for (let i = 0; i < 20 && Date.now() - t0 < 40000; i++) {");
    expect(src).toContain("await page.waitForTimeout(500);");
    // The field-error collector is bounded twice: five nodes at 6 s each on an early tick,
    // and the same 40 s deadline on the last one.
    expect(src).toContain("for (const n of nodes.slice(0, 5)) {");
    expect(src).toContain("if (Date.now() - t0 > 40000) break;");
  });
});

describe("generateOtpScript", () => {
  it("emits a sandbox-safe script that carries the code and the job as data", () => {
    const src = generateOtpScript("BMCHFZGE", JOB);
    expectSandboxSafe(src);
    expect(splitScript(src).data).toBe(`const data = {"code":"BMCHFZGE","jobId":"${JOB}"};`);
  });

  it("validates the code in the script rather than at generation time", () => {
    const src = generateOtpScript("not a code!", JOB);
    expectSandboxSafe(src);
    expect(splitScript(src).data).toContain("not a code!");
    expect(splitScript(src).template).toContain("/^[A-Za-z0-9]{4,10}$/");
    expect(src).toContain('state: "error", detail: "invalid code"');
  });

  it("keeps a code that reads like code inside the data literal", () => {
    const src = generateOtpScript(INJECTION, JOB);
    expectSandboxSafe(src);
    expect(src.split(INJECTION)).toHaveLength(2);
    expect(splitScript(src).data).toContain(INJECTION);
  });

  it("types the whole code into the first box before falling back to one box per character", () => {
    const src = generateOtpScript("BMCHFZGE", JOB);
    expect(src).toContain('const boxes = root.locator(\'input[maxlength="1"]\');');
    expect(src).toContain("await boxes.first().pressSequentially(code, { delay: 40, timeout: 5000 });");
    // One pass per box, writing the character it should hold and clearing every box past the
    // end of the code — the same end state the old clear-then-fill pair reached in two.
    expect(src).toContain('await boxes.nth(i).fill(code[i] || "", { timeout: 5000 });');
    expect(src).toContain('detail: "code did not stick: "');
    expect(src).toContain('detail: "no security-code boxes found"');
  });

  it("clicks Submit application a second time and waits for a confirmation", () => {
    const src = generateOtpScript("BMCHFZGE", JOB);
    expect(src).toContain('await root.getByRole("button", { name: "Submit application" }).click({ timeout: 5000 });');
    expect(src).toContain(CONFIRMED_WORDINGS);
    for (const state of ["submitted", "error", "captcha"]) expect(src, state).toContain(`state: "${state}"`);
  });

  it("takes the same confirmation-wording baseline before its own click", () => {
    const src = generateOtpScript("BMCHFZGE", JOB);
    expect(src).toContain("const preConfirmed = confirmedText(await bodyText());");
    expect(src.indexOf("const preConfirmed")).toBeLessThan(src.indexOf('name: "Submit application"'));
  });

  it("refuses to run anywhere but on the job it was written for", () => {
    const src = generateOtpScript("BMCHFZGE", JOB);
    expect(src).toContain(
      `!new RegExp("(/jobs/|gh_jid=|token=)" + data.jobId + "(?!\\\\d)").test(page.url() + " " + root.url())`,
    );
    expect(src).toContain('detail: "wrong page: expected job " + data.jobId');
    expect(src.indexOf("gh_jid=")).toBeLessThan(src.indexOf("root.locator"));
  });

  it("throws rather than emitting a script whose page guard could never fire", () => {
    expect(() => generateOtpScript("BMCHFZGE", "not-an-id")).toThrow(
      /Refusing to generate a OTP script for job id "not-an-id"/,
    );
    expect(() => generateSubmitScript("")).toThrow(/Refusing to generate a submit script/);
    expect(() => generateFillScript([], "/r.pdf", "8654510002x")).toThrow(
      /Refusing to generate a fill script for job id/,
    );
  });
});

// ── A fake `page`, so a generated script can actually be run ──
//
// Everything above checks what the generated source *says*. These check what it *does*: the
// source is evaluated the way run_code evaluates it — `new Function("return " + src)()` —
// and driven against a stand-in for Playwright's `Page`. It is the only way to test the poll
// layer, where the bugs are decisions about ordering and about what counts as evidence.

interface FakeNode {
  /** How many elements the selector matches. A registered node matches 1 by default. */
  count?: number;
  text?: string;
  texts?: string[];
  value?: string;
  attrs?: Record<string, string>;
  /** `waitFor({ state: "visible" })` rejects on false and `isVisible()` returns it. */
  visible?: boolean;
  /**
   * A checkbox that is already ticked before the script touches it, which is what a re-run
   * over a form that already holds its answers walks into. `check()` sets it for the rest of
   * the run; `isChecked()` reads either.
   */
  checked?: boolean;
  /** Every action on this node rejects with this message. */
  throws?: string;
  /** A security-code group that auto-advances: typing into the first box fills them all. */
  autoAdvance?: boolean;
  /** Records a write and drops it, like a field that quietly refuses input. */
  readOnly?: boolean;
  /** Upper-cases whatever is typed into it, the way some security-code groups do. */
  upperCases?: boolean;
  /**
   * What an action on this node costs the fake clock, whether it succeeds or throws: one
   * number for every method alike, or a record naming the methods that cost anything (the
   * rest cost nothing). A node with no `costMs` is instant when it works and costs the
   * caller's own `timeout` when it does not, which is what a real Playwright call does.
   */
  costMs?: number | Record<string, number>;
  /**
   * What the settle asks an element handle. `connected` is the element still being in the
   * document; `hydrated` is React having attached a fiber key to it. Both default to true and
   * both read the clock, so a scenario can hydrate late, or have the node replaced under the
   * script without any navigation happening — the two causes the settle exists for.
   */
  connected?: (at: PageState) => boolean;
  hydrated?: (at: PageState) => boolean;
  /**
   * `elementHandle()` rejects while this is true, though the element is visible to a
   * `waitFor` — the window in which an anchor is seen and then detaches before it can be
   * held, which is one of the ways a settle attempt fails without the fill failing.
   */
  noHandle?: (at: PageState) => boolean;
  /**
   * Reads that come back empty before the typed value shows, the way a remount wipes a field
   * that was already filled. One is recoverable by refilling; two is a field that never held.
   */
  wipeReads?: number;
}

/** Where the script has got to: half-second polls elapsed, clicks made, and time spent. */
interface PageState {
  tick: number;
  clicks: number;
  /**
   * Every path `click()` has been called on. `clicks` counts only the submit button, which
   * is what the submit and OTP scenarios key off; a scenario that has to react to some other
   * click — the twin's "Enter manually", which mounts a textarea that was not in the DOM —
   * reads this instead.
   */
  clicked: string[];
  /**
   * Milliseconds, as the script's own `Date.now()` reports them. Every waiting call and every
   * `waitForTimeout` moves it, which is what lets a scenario drive the wall-clock deadlines
   * without a test that actually takes forty seconds.
   */
  clock: number;
  /** setInputFiles calls made so far, so a scenario can confirm a file only on the second attempt. */
  uploads: number;
  /**
   * Every key `page.keyboard.press` has sent, in order. A react-select scenario models its
   * open menu off this: option 0 is focused when the menu opens, each `ArrowDown` moves the
   * focus down one, and the `Tab` that commits takes whichever option is focused then.
   */
  keys: string[];
  /**
   * Every path `check()` has been called on, in order — the checkbox-group counterpart of
   * `clicked`. A box already ticked is still checked again, because `check()` is idempotent
   * and the fill leans on that to stay safe to re-run.
   */
  checked: string[];
}

interface Scenario {
  dom: (at: PageState) => Record<string, FakeNode>;
  url?: (at: PageState) => string;
  title?: (at: PageState) => string;
  /**
   * The Greenhouse iframe a company-hosted board renders the form in.
   *
   * `gen` is which frame object is asking. `generation` bumps it, and a bumped generation is
   * a *new* `Frame` — the way a parent-page reload replaces the old one — so a scenario can
   * leave the frame the script is still holding dead while the fresh one navigates on.
   */
  embed?: {
    url: (at: PageState, gen: number) => string;
    dom: (at: PageState, gen: number) => Record<string, FakeNode>;
    title?: (at: PageState, gen: number) => string;
    generation?: (at: PageState) => number;
  };
  /** Whether the embed is in `page.frames()` yet — a frame still mounting is not. */
  frames?: (at: PageState) => boolean;
}

/** The options every waiting call carries, since the templates always pass one. */
interface Waited {
  timeout?: number;
}

interface FakeLocator {
  locator(sub: string, options?: { hasText?: string }): FakeLocator;
  first(): FakeLocator;
  nth(i: number): FakeLocator;
  count(): Promise<number>;
  all(): Promise<FakeLocator[]>;
  innerText(options?: Waited): Promise<string>;
  allInnerTexts(): Promise<string[]>;
  inputValue(options?: Waited): Promise<string>;
  fill(value: string, options?: Waited): Promise<void>;
  click(options?: Waited): Promise<void>;
  setInputFiles(path: string, options?: Waited): Promise<void>;
  pressSequentially(text: string, options?: Waited & { delay?: number }): Promise<void>;
  waitFor(options?: Waited & { state?: string }): Promise<void>;
  isVisible(options?: Waited): Promise<boolean>;
  check(options?: Waited): Promise<void>;
  isChecked(options?: Waited): Promise<boolean>;
  getAttribute(name: string, options?: Waited): Promise<string | null>;
  elementHandle(options?: Waited): Promise<FakeHandle>;
}

/**
 * A handle on the element as it stands right now. The object it hands to `evaluate` carries
 * the two things the settle reads — `isConnected`, and a `__reactFiber$…` key once the node
 * says it is hydrated — and nothing else a real handle can do.
 */
interface FakeHandle {
  el(): Record<string, unknown>;
  evaluate(fn: (n: Record<string, unknown>) => unknown): Promise<unknown>;
}

/** What `page` and every `Frame` both offer, which is all the templates ask of `root`. */
interface FakeFrame {
  locator(path: string, options?: { hasText?: string }): FakeLocator;
  getByRole(role: string, options: { name: string }): FakeLocator;
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(
    fn: (n: Record<string, unknown>) => unknown,
    arg?: FakeHandle,
    options?: { timeout?: number; polling?: number },
  ): Promise<void>;
}

/**
 * Evaluate a generated script and run it against `scenario`.
 *
 * A locator is addressed by the selector string it was built from, with chained calls joined
 * by `>>` and `nth(i)` suffixed as `[i]` — so a scenario registers exactly the paths the
 * template queries, and a template that starts querying something else fails loudly with
 * "resolved to no element" rather than silently passing. Only `waitForTimeout(500)` advances
 * the tick, because that is the poll's own step; the fill script's 250 ms menu poll and its
 * 200 ms settle are part of the react-select dance and leave the page where it was.
 *
 * `locator(sel, { hasText })` carries Playwright's text filter rather than folding it into
 * the path: the filter is applied here, against the node's own text, so a test of "the
 * upload is confirmed only when the filename node names *this* file" actually exercises the
 * match instead of asserting a key the scenario itself chose.
 *
 * Time is fake and `Date.now` is stubbed to read it, so a scenario can put a script up
 * against its own 30 s / 40 s deadline in a millisecond. Every call that would wait — and
 * every call that times out — moves `at.clock`; nothing else does.
 */
async function runScript(
  src: string,
  scenario: Scenario,
): Promise<{ result: Record<string, unknown>; calls: string[]; at: PageState }> {
  const calls: string[] = [];
  const typed = new Map<string, string>();
  const reads = new Map<string, number>();
  /** Boxes `check()` has ticked, so `isChecked()` reads back what the script just did. */
  const ticked = new Set<string>();
  const at: PageState = { tick: 0, clicks: 0, clicked: [], clock: 0, uploads: 0, keys: [], checked: [] };

  const waitForTimeout = async (ms: number) => {
    calls.push(`wait ${ms}`);
    at.clock += ms;
    if (ms === 500) at.tick++;
  };

  /**
   * Poll `fn` on the fake clock until it returns something truthy, or until `timeout` of clock
   * has gone by — which rejects, the way Playwright does. A handle is unwrapped to the element
   * it stands for, because that is what Playwright passes the callback, and each attempt costs
   * `polling` milliseconds so a scenario that hydrates at a given clock reading actually gets
   * there.
   */
  const waitForFunction = async (
    fn: (n: Record<string, unknown>) => unknown,
    arg?: FakeHandle,
    options?: { timeout?: number; polling?: number },
  ) => {
    const step = Math.max(1, options?.polling ?? 100);
    const budget = options?.timeout ?? 30_000;
    const started = at.clock;
    for (;;) {
      if (fn(arg === undefined ? {} : arg.el())) return;
      if (at.clock - started >= budget) throw new Error("waitForFunction: timed out");
      at.clock += step;
    }
  };

  /**
   * One document — the top page's, or a frame's — as a locator factory.
   *
   * `label` prefixes everything the document records, so a scenario can tell `fill input#email`
   * in the page from `embed:fill input#email` in the iframe, and so two documents holding the
   * same selector never share what was typed into it.
   */
  const documentOf = (label: string, domOf: () => Record<string, FakeNode>) => {
    const node = (path: string): FakeNode | undefined => {
      const dom = domOf();
      let found = dom[path];
      if (found === undefined) {
        // An indexed path falls back to the group it indexes into: a security-code group's
        // boxes are registered once and are alike apart from what has been typed into each.
        const indexed = /^(.*)\[\d+\]$/.exec(path);
        if (indexed !== null) found = dom[indexed[1]];
      }
      if (found === undefined) {
        // A comma-joined selector falls back to its branches, so a scenario can register the
        // half it wants: `input#first_name, input#email` is one locator to Playwright and
        // either of two nodes to the page. Whole-selector keys still win, being exact.
        for (const branch of path.split(", ")) {
          const alt = dom[branch];
          if (alt !== undefined) {
            found = alt;
            break;
          }
        }
      }
      if (found === undefined) return undefined;
      const written = typed.get(label + path);
      return written === undefined ? found : { ...found, value: written };
    };

    /** What this node charges for `method`, or undefined when the scenario said nothing. */
    const costOf = (found: FakeNode | undefined, method: string): number | undefined => {
      const cost = found?.costMs;
      if (cost === undefined) return undefined;
      return typeof cost === "number" ? cost : (cost[method] ?? 0);
    };

    /**
     * Run one action and charge the clock. A node's `costMs` is what it costs whether the
     * action works or not; without one, a call that throws costs the `timeout` it was given
     * — a Playwright timeout *is* the wait — and a call that works costs nothing.
     */
    const spend = <T>(method: string, path: string, options: Waited | undefined, run: () => T): T => {
      const cost = costOf(node(path), method);
      try {
        const value = run();
        at.clock += cost ?? 0;
        return value;
      } catch (e) {
        at.clock += cost ?? options?.timeout ?? 0;
        throw e;
      }
    };

    const act = (name: string, path: string): FakeNode => {
      calls.push(`${label}${name} ${path}`);
      const found = node(path);
      if (found === undefined) throw new Error(`locator("${path}") resolved to no element`);
      if (found.throws !== undefined) throw new Error(found.throws);
      return found;
    };

    /** Every string a node offers `hasText`, which Playwright matches case-insensitively. */
    const textsOf = (found: FakeNode): string[] =>
      found.texts ?? (found.text === undefined ? [] : [found.text]);

    const shows = (found: FakeNode, hasText: string): boolean =>
      textsOf(found).some((t) => t.toLowerCase().includes(hasText.toLowerCase()));

    const locator = (path: string, hasText?: string): FakeLocator => ({
      locator: (sub, options) => locator(`${path} >> ${sub}`, options?.hasText),
      first: () => locator(path, hasText),
      nth: (i) => locator(`${path}[${i}]`, hasText),
      count: async () => {
        const found = node(path);
        if (found === undefined) return 0;
        if (hasText !== undefined && !shows(found, hasText)) return 0;
        return found.count ?? 1;
      },
      all: async () => {
        const found = node(path);
        const many = found === undefined ? 0 : (found.count ?? 1);
        return Array.from({ length: many }, (_, i) => locator(many === 1 ? path : `${path}[${i}]`));
      },
      innerText: async (options) => spend("innerText", path, options, () => act("innerText", path).text ?? ""),
      allInnerTexts: async () => {
        const found = node(path);
        if (found === undefined) return [];
        if (found.texts !== undefined) return found.texts;
        return found.text === undefined ? [] : [found.text];
      },
      inputValue: async (options) =>
        spend("inputValue", path, options, () => {
          const found = act("inputValue", path);
          if (found.wipeReads !== undefined) {
            const seen = (reads.get(label + path) ?? 0) + 1;
            reads.set(label + path, seen);
            if (seen <= found.wipeReads) return "";
          }
          return found.value ?? "";
        }),
      fill: async (value, options) =>
        spend("fill", path, options, () => {
          const found = act("fill", path);
          if (found.readOnly !== true) {
            typed.set(label + path, found.upperCases === true ? value.toUpperCase() : value);
          }
        }),
      click: async (options) =>
        spend("click", path, options, () => {
          act("click", path);
          at.clicked.push(label + path);
          if (path.startsWith("role=button")) at.clicks++;
        }),
      setInputFiles: async (file, options) =>
        spend("setInputFiles", path, options, () => {
          act("setInputFiles", path);
          at.uploads++;
          calls.push(`${label}upload ${file}`);
        }),
      pressSequentially: async (text, options) =>
        spend("pressSequentially", path, options, () => {
          const found = act("pressSequentially", path);
          if (found.readOnly === true) return;
          const typing = found.upperCases === true ? text.toUpperCase() : text;
          if (found.autoAdvance === true) {
            for (let i = 0; i < typing.length; i++) typed.set(`${label}${path}[${i}]`, typing[i]);
          } else typed.set(label + path, typing);
        }),
      waitFor: async (options) =>
        spend("waitFor", path, options, () => {
          const found = act("waitFor", path);
          if (found.visible === false) throw new Error(`${path} never became visible`);
          if (hasText !== undefined && !shows(found, hasText)) {
            throw new Error(`${path} never showed text containing ${JSON.stringify(hasText)}`);
          }
        }),
      isVisible: async () => {
        const found = node(path);
        return found !== undefined && found.visible !== false;
      },
      check: async (options) =>
        spend("check", path, options, () => {
          act("check", path);
          ticked.add(label + path);
          at.checked.push(label + path);
        }),
      isChecked: async (options) =>
        spend("isChecked", path, options, () => {
          const found = act("isChecked", path);
          return ticked.has(label + path) || found.checked === true;
        }),
      getAttribute: async (name, options) =>
        spend("getAttribute", path, options, () => act("getAttribute", path).attrs?.[name] ?? null),
      elementHandle: async (options) =>
        spend("elementHandle", path, options, () => {
          const held = act("elementHandle", path);
          if (held.noHandle?.(at) === true) throw new Error(`${path} detached before it could be held`);
          const el = () => {
            const found = node(path);
            const shape: Record<string, unknown> = {
              isConnected: found !== undefined && (found.connected?.(at) ?? true),
            };
            if (found !== undefined && (found.hydrated?.(at) ?? true)) shape.__reactFiber$fake = {};
            return shape;
          };
          return { el, evaluate: async (fn: (n: Record<string, unknown>) => unknown) => fn(el()) };
        }),
    });

    return {
      locator: (path: string, options?: { hasText?: string }) => locator(path, options?.hasText),
      getByRole: (role: string, options: { name: string }) => locator(`role=${role}[name="${options.name}"]`),
    };
  };

  const top = documentOf("", () => scenario.dom(at));
  const pageUrl = () => scenario.url?.(at) ?? `https://job-boards.greenhouse.io/acme/jobs/${JOB}`;

  /** The main frame: the same document as the page, and the object `pick()` excludes. */
  const mainFrame: FakeFrame = {
    ...top,
    url: pageUrl,
    title: async () => scenario.title?.(at) ?? "",
    waitForTimeout,
    waitForFunction,
  };

  // One `Frame` object per generation, so a frame the script is holding stays the object it
  // was — and a generation the scenario has moved past keeps answering as its own stale self.
  const embeds = new Map<number, FakeFrame>();
  const embedFrame = (): FakeFrame | undefined => {
    const spec = scenario.embed;
    if (spec === undefined) return undefined;
    if (scenario.frames !== undefined && !scenario.frames(at)) return undefined;
    const gen = spec.generation?.(at) ?? 0;
    let frame = embeds.get(gen);
    if (frame === undefined) {
      frame = {
        ...documentOf("embed:", () => spec.dom(at, gen)),
        url: () => spec.url(at, gen),
        title: async () => spec.title?.(at, gen) ?? "",
        waitForTimeout,
        waitForFunction,
      };
      embeds.set(gen, frame);
    }
    return frame;
  };

  const page = {
    ...top,
    keyboard: {
      press: async (key: string) => {
        calls.push(`key ${key}`);
        at.keys.push(key);
      },
    },
    waitForTimeout,
    waitForFunction,
    title: async () => scenario.title?.(at) ?? "",
    url: pageUrl,
    frames: () => {
      const embed = embedFrame();
      return embed === undefined ? [mainFrame] : [mainFrame, embed];
    },
    mainFrame: () => mainFrame,
  };

  vi.spyOn(Date, "now").mockImplementation(() => at.clock);
  const fn = new Function(`return ${src}`)() as (p: unknown) => Promise<unknown>;
  return { result: (await fn(page)) as Record<string, unknown>, calls, at };
}

/** The selectors the templates query, spelled once so a scenario and the source agree. */
const SEL = {
  body: "body",
  captcha: 'iframe[src*="hcaptcha"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="turnstile"]',
  otpBoxes: 'input[maxlength="1"]',
  // One selector, not two: `formGone` counts submit buttons and forms in a single query.
  formOrButton: "button[type=submit], form",
  errors: '[aria-invalid="true"], .field-error, form [role="alert"]',
  uploadWrapper: 'xpath=ancestor::*[contains(@class,"file-upload")][1]',
  uploadFilename: ".file-upload__filename",
  manualButton: 'button:has-text("enter manually"), [role=button]:has-text("enter manually")',
  fieldGroup: "xpath=ancestor::*[.//button][1]",
  selectOption: ".select__option",
};

/** The react-select read-back paths for a combobox `sel`. */
const singleValueOf = (sel: string) => `${sel} >> xpath=ancestor::*[contains(@class,"select__control")][1] >> .select__single-value`;
const multiValuesOf = (sel: string) => `${sel} >> xpath=ancestor::*[contains(@class,"select__control")][1] >> .select__multi-value__label`;

/** The path `getByRole("button", { name: "Submit application" })` resolves to. */
const SUBMIT_BUTTON = 'role=button[name="Submit application"]';

/**
 * Where a company-hosted board serves its Greenhouse iframe from. `pick()` recognises a
 * frame by `greenhouse.io/embed/job_app`, and `token=` is where the embed carries the job id
 * for a careers page whose own URL says nothing about it.
 */
const EMBED_URL = `https://job-boards.greenhouse.io/embed/job_app?token=${JOB}`;

/**
 * Where the fill script looks for proof that a file actually landed: the filename node
 * Greenhouse swaps in, inside the field's own `.file-upload` wrapper. Registering one with
 * the uploaded basename as its text is what makes an upload "confirmed"; leaving it out, or
 * giving it another file's name, is what makes one "not confirmed".
 */
const filenameIn = (fileSel: string) => `${fileSel} >> ${SEL.uploadWrapper} >> ${SEL.uploadFilename}`;

/** Where the same script looks for the twin's "Enter manually" button. */
const manualIn = (fileSel: string) => `${fileSel} >> ${SEL.fieldGroup} >> ${SEL.manualButton}`;

/** The group `groupRefFor` builds, and one box of it as `nth(i)` addresses it. */
const groupOf = (id: string) => `input[type="checkbox"][name="${id}"]`;
const boxOf = (id: string, i: number) => `${groupOf(id)}[${i}]`;

/**
 * The checkbox group some boards render a `[]` multi-select as, in place of a react-select.
 *
 * One node for the group, whose `count` is what the fill walks; one per box under its own
 * `nth(i)` path, carrying the id Greenhouse gives it (`<question id>_<option id>`); and one
 * `<label for>` per box holding the option's text, which is the only place the wording lives
 * — a checkbox carries no label of its own. `alreadyChecked` names boxes by that same id, so
 * a scenario can put the script in front of a form it has already filled once.
 */
const checkboxGroup = (
  id: string,
  options: string[],
  alreadyChecked: string[] = [],
): Record<string, FakeNode> => {
  const dom: Record<string, FakeNode> = { [groupOf(id)]: { count: options.length } };
  options.forEach((option, i) => {
    const boxId = `${id}_${i}`;
    dom[boxOf(id, i)] = { attrs: { id: boxId }, checked: alreadyChecked.includes(boxId) };
    dom[`label[for="${boxId}"]`] = { text: option };
  });
  return dom;
};

/** A form that is up and unsubmitted, showing `text`. */
const formUp = (text: string): Record<string, FakeNode> => ({
  [SEL.body]: { text },
  [SEL.formOrButton]: {},
  [SUBMIT_BUTTON]: {},
});

/**
 * The one field the fill script anchors itself on before it touches anything else. Its two
 * halves ride in a single locator, so a DOM registers the whole selector and the fake page's
 * comma fallback lets a scenario that wants `input#first_name` on its own have that instead.
 */
const ANCHOR = "input#first_name, input#email";

/**
 * A document with a Greenhouse form in it: the anchor, an already-open react-select menu, and
 * whatever the scenario adds.
 *
 * The menu is registered by default because the select dance polls `.select__option` and an
 * unregistered selector counts zero: without it every scenario holding a select would spend
 * the poll's whole 2 s ceiling per option against the fill's 30 s deadline, and start
 * reporting "out of time" for reasons its own assertions say nothing about. One option is
 * what a real page with an open menu offers; a scenario that wants a slow or absent menu
 * overrides the key, which is spread after this one.
 */
const fillable = (dom: Record<string, FakeNode>): Record<string, FakeNode> => ({
  [ANCHOR]: {},
  [SEL.selectOption]: {},
  ...dom,
});

const waits = (calls: string[]) => calls.filter((c) => c === "wait 500").length;

describe("the generated scripts, run against a fake page", () => {
  // `runScript` stubs `Date.now` to read its own fake clock; nothing outside it may see that.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the fake page's selectors in step with the ones the templates query", () => {
    const submit = generateSubmitScript(JOB);
    for (const sel of [SEL.body, SEL.captcha, SEL.otpBoxes, SEL.formOrButton, SEL.errors]) {
      expect(submit, sel).toContain(sel);
    }
    expect(generateOtpScript("BMCHFZGE", JOB)).toContain(SEL.otpBoxes);
    const fill = generateFillScript(TEXT_FILE_SELECT, "/abs/resume.pdf", JOB);
    for (const sel of [SEL.uploadWrapper, SEL.uploadFilename, SEL.manualButton, SEL.fieldGroup, SEL.selectOption]) {
      expect(fill, sel).toContain(sel);
    }
  });

  describe("submit", () => {
    it("reports a CAPTCHA that is already up without clicking anything", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({ ...formUp("Apply for this job"), [SEL.captcha]: {} }),
      });
      expect(result).toEqual({ state: "captcha" });
      expect(calls.some((c) => c.startsWith("click role=button"))).toBe(false);
    });

    it("reports a CAPTCHA that the click raises in place of the form, not a submission", async () => {
      // The form and the button are both gone, which used to read as `submitted`.
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) =>
          clicks === 0 ? formUp("Apply for this job") : { [SEL.body]: { text: "" }, [SEL.captcha]: {} },
      });
      expect(result).toEqual({ state: "captcha" });
    });

    it("reports a form that vanished with nothing confirming it as unknown, never submitted", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) =>
          clicks === 0 ? formUp("Apply for this job") : { [SEL.body]: { text: "Session expired. Please start over." } },
        title: () => "Session expired",
      });
      expect(result.state).toBe("unknown");
      expect(String(result.detail)).toContain("Session expired");
      expect(String(result.detail)).toContain("form gone, nothing confirmed it");
    });

    it("reports submitted on the confirmation wording", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: ({ tick }) =>
          tick < 2 ? formUp("Submitting…") : { [SEL.body]: { text: "Thank you for applying. We will be in touch." } },
      });
      expect(result).toEqual({ state: "submitted" });
      // It polled rather than answering from the pre-click page.
      expect(waits(calls)).toBe(2);
    });

    it("reports submitted on a confirmation URL even while the form is still up", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: () => formUp("…"),
        url: ({ clicks }) =>
          clicks === 0
            ? `https://job-boards.greenhouse.io/acme/jobs/${JOB}`
            : `https://job-boards.greenhouse.io/acme/jobs/${JOB}/confirmation`,
      });
      expect(result).toEqual({ state: "submitted" });
    });

    it("keeps polling through a blank tick mid-navigation instead of giving up on it", async () => {
      // The tick straight after the click has no form and no text yet. Returning `unknown`
      // there loses the confirmation that arrives a tick later, and the caller re-runs an
      // application that actually went through.
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks, tick }) => {
          if (clicks === 0) return formUp("Apply for this job");
          if (tick < 2) return { [SEL.body]: { text: "" } };
          return { [SEL.body]: { text: "Thank you for applying." } };
        },
      });
      expect(result).toEqual({ state: "submitted" });
      expect(waits(calls)).toBe(2);
    });

    it("still reports the vanished form once the whole poll has expired", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) => (clicks === 0 ? formUp("Apply for this job") : { [SEL.body]: { text: "" } }),
        title: () => "Session expired",
      });
      expect(result.state).toBe("unknown");
      expect(String(result.detail)).toContain("form gone, nothing confirmed it");
      // It used the whole ten seconds looking rather than answering on the first blank tick.
      expect(waits(calls)).toBe(20);
    });

    it("recognises every wording a Greenhouse success page uses", async () => {
      const wordings = [
        "Thank you for applying.",
        "Thanks for applying! We will review your application.",
        "We have received your application.",
        "Your application was received.",
        "Your application has been submitted.",
        "Application submitted.",
        "Your application was successfully submitted.",
        "We'll be in touch soon.",
      ];
      for (const text of wordings) {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: ({ clicks }) => (clicks === 0 ? formUp("Apply for this job") : { [SEL.body]: { text } }),
        });
        expect(result, text).toEqual({ state: "submitted" });
      }
    });

    it("reports otp_required when the security-code group appears", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) =>
          clicks === 0 ? formUp("Apply") : { ...formUp("Enter the security code we emailed you"), [SEL.otpBoxes]: { count: 8 } },
      });
      expect(result).toEqual({ state: "otp_required" });
    });

    it("does not believe an error node on the first tick, and still submits when it clears", async () => {
      // A live region reading "Saving your answers" used to return `validation_errors` at
      // t=500 ms, and the caller's answer to that is to submit again.
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: ({ tick }) => {
          if (tick < 2) return { ...formUp("Saving your answers…"), [SEL.errors]: { text: "Saving your answers…" } };
          return { [SEL.body]: { text: "Thank you for applying." } };
        },
      });
      expect(result).toEqual({ state: "submitted" });
      expect(calls.some((c) => c.startsWith("innerText " + SEL.errors))).toBe(false);
    });

    it("reports a validation error that is still there once the page has settled", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({
          ...formUp("Apply for this job"),
          [SEL.errors]: { text: "This field is required.", attrs: { id: "first_name", "aria-label": "First Name" } },
        }),
      });
      expect(result.state).toBe("validation_errors");
      expect(result.validation_errors).toEqual([
        { error: "This field is required.", id: "first_name", label: "First Name" },
      ]);
      // Held back until the third tick, so a transient node cannot short-circuit the poll.
      expect(waits(calls)).toBe(3);
    });

    it("reads the message of an invalid input off the node its aria-errormessage names", async () => {
      // Greenhouse's invalid controls have no text of their own; the message is a sibling
      // <p id="<id>-error">. The live run's empty required multi-select looked exactly like
      // this and v2 reported `unknown` twice.
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({
          ...formUp("Apply for this job"),
          [SEL.errors]: { text: "", attrs: { id: "question_67918863[]", "aria-errormessage": "question_67918863[]-error", "aria-label": "In what cities are you available to work?" } },
          ['[id="question_67918863[]-error"]']: { text: "This field is required." },
        }),
      });
      expect(result.state).toBe("validation_errors");
      expect(result.validation_errors).toEqual([
        { error: "This field is required.", id: "question_67918863[]", label: "In what cities are you available to work?" },
      ]);
    });

    it("falls back to <id>-error when the invalid input names no error message", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({
          ...formUp("Apply for this job"),
          [SEL.errors]: { text: "", attrs: { id: "phone" } },
          ['[id="phone-error"]']: { text: "Enter a valid phone number." },
        }),
      });
      expect(result.validation_errors).toEqual([{ error: "Enter a valid phone number.", id: "phone" }]);
    });

    it("keeps polling past an invalid input whose message never shows, and still sees the confirmation", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: (at) => at.tick < 6
          ? { ...formUp("Apply for this job"), [SEL.errors]: { text: "", attrs: { id: "phone" } } }
          : { [SEL.body]: { text: "Thank you for applying." } },
      });
      expect(result.state).toBe("submitted");
    });

    it("does not mistake a stale upload error for a validation error", async () => {
      // Greenhouse never clears <p id="resume-error"> after a later successful attach, and no
      // control points at it with aria-invalid — so it is not evidence, and the poll goes on
      // to the confirmation.
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: (at) => at.tick < 4
          ? {
              ...formUp("Apply for this job"),
              // Registered under the wildcard the rejected design would have used, so the
              // mutation check actually exercises it; the shipped selector never resolves
              // this key, which is the point.
              '[id$="-error"]': {
                text: "Cannot read properties of undefined (reading 'uploadFile')",
                attrs: { id: "resume-error" },
              },
            }
          : { [SEL.body]: { text: "Thank you for applying." } },
      });
      expect(result.state).toBe("submitted");
    });

    /**
     * C2. A job description is on the page while the form is, and plenty of them say
     * "we'll be in touch" in their own prose. Without a pre-click baseline the very first
     * poll tick reads that as a confirmation and returns `submitted` — which is terminal:
     * the queue entry is moved to applied and the application is never retried, whether or
     * not the click did anything at all.
     */
    describe("a job description that already says the words a confirmation says", () => {
      const JD = "About the role. We move fast and we'll be in touch within a week.";

      it("does not call it submitted while the form is still up", async () => {
        const { result, calls } = await runScript(generateSubmitScript(JOB), {
          dom: () => formUp(JD),
          title: () => "Careers at Acme",
        });
        expect(result.state).toBe("unknown");
        expect(String(result.detail)).toContain("Careers at Acme");
        expect(String(result.detail)).not.toContain("form gone");
        // It spent the whole poll looking rather than answering from the description.
        expect(waits(calls)).toBe(20);
      });

      it("clicks exactly once when the description already says the words a confirmation says", async () => {
        const { result, calls } = await runScript(generateSubmitScript(JOB), {
          dom: () => formUp(JD),
          title: () => "Careers at Acme",
        });
        expect(result.state).toBe("unknown");
        expect(calls.filter((c) => c.startsWith("click "))).toHaveLength(1);
      });

      it("does call it submitted once the wording outlives the form", async () => {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: ({ clicks }) => (clicks === 0 ? formUp(JD) : { [SEL.body]: { text: JD } }),
        });
        expect(result).toEqual({ state: "submitted" });
      });

      it("does call it submitted on the URL signal, which the baseline never touches", async () => {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: () => formUp(JD),
          url: ({ clicks }) =>
            clicks === 0
              ? `https://job-boards.greenhouse.io/acme/jobs/${JOB}`
              : `https://job-boards.greenhouse.io/acme/jobs/${JOB}/confirmation`,
        });
        expect(result).toEqual({ state: "submitted" });
      });
    });

    it("returns submitted without clicking when the page already shows confirmation", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({ [SEL.body]: { text: "Thank you for applying." } }),
      });
      expect(result).toEqual({ state: "submitted", detail: "already confirmed" });
      expect(calls.some((c) => c.startsWith("click "))).toBe(false);
    });

    it("returns already confirmed without clicking when the URL already has /confirmation", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: () => formUp("About the role."),
        url: () => `https://job-boards.greenhouse.io/acme/jobs/${JOB}/confirmation`,
      });
      expect(result).toEqual({ state: "submitted", detail: "already confirmed" });
      expect(calls.some((c) => c.startsWith("click "))).toBe(false);
    });

    it("still reports submitted when the wording was absent before the click", async () => {
      // The regression guard for the baseline: a page whose description says none of it, and
      // a confirmation that arrives afterwards, must still be `submitted`.
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) =>
          clicks === 0
            ? formUp("About the role. Acme builds analytics for teams.")
            : formUp("About the role. Acme builds analytics for teams. Thank you for applying."),
      });
      expect(result).toEqual({ state: "submitted" });
    });

    /** Ruling P: the tab moved between writing the script and running it. */
    it("refuses to click when the browser is on another job", async () => {
      const { result, calls } = await runScript(generateSubmitScript(JOB), {
        dom: () => formUp("Apply for this job"),
        url: () => "https://job-boards.greenhouse.io/acme/jobs/9999999999",
      });
      expect(result).toEqual({ state: "error", detail: `wrong page: expected job ${JOB}` });
      // One `wait 1000`, and nothing else: the re-pick that gives a slow embed its second
      // chance runs before the guard, since the guard's `token=` clause needs the embed.
      expect(calls).toEqual(["wait 1000"]);
    });

    it("accepts a company-hosted embed that carries the job in gh_jid", async () => {
      const { result } = await runScript(generateSubmitScript(JOB), {
        dom: ({ clicks }) =>
          clicks === 0 ? formUp("Apply") : { [SEL.body]: { text: "Thank you for applying." } },
        url: () => `https://acme.com/careers?gh_jid=${JOB}&gh_src=abc`,
      });
      expect(result).toEqual({ state: "submitted" });
    });

    /**
     * The digit-boundary guard: without it, `data.jobId` "1234" would match the leading
     * digits of `/jobs/12345` and the script would click a submit button for the wrong
     * posting. `(?!\d)` in the guard's pattern is what refuses that.
     */
    it("refuses a job id that is only a leading substring of the page's", async () => {
      const { result, calls } = await runScript(generateSubmitScript("1234"), {
        dom: () => formUp("Apply for this job"),
        url: () => "https://job-boards.greenhouse.io/acme/jobs/12345",
      });
      expect(result).toEqual({ state: "error", detail: "wrong page: expected job 1234" });
      expect(calls).toEqual(["wait 1000"]);
    });

    it("still proceeds when the page's job id matches exactly", async () => {
      const { result } = await runScript(generateSubmitScript("1234"), {
        dom: ({ clicks }) =>
          clicks === 0 ? formUp("Apply for this job") : { [SEL.body]: { text: "Thank you for applying." } },
        url: () => "https://job-boards.greenhouse.io/acme/jobs/1234",
      });
      expect(result).toEqual({ state: "submitted" });
    });

    /**
     * Decision 12. A company-hosted board renders the form in a `greenhouse.io/embed/job_app`
     * iframe, and everything this script reads — the body text, the security-code group, the
     * form-gone probe, the button it clicks — has to come from that frame. A `page.` locator
     * matches nothing at all inside one, which is how the first live run on a hosted board
     * clicked nothing and reported nothing.
     */
    describe("a form rendered inside the Greenhouse embed", () => {
      const CONFIRMED_EMBED = `https://job-boards.greenhouse.io/embed/job_app/confirmation?token=${JOB}`;

      it("clicks the button in the frame and reports the security code it raises", async () => {
        const { result, calls } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            dom: ({ tick }) =>
              tick < 2
                ? formUp("Apply for this job")
                : { ...formUp("Enter the security code we emailed you"), [SEL.otpBoxes]: { count: 8 } },
          },
        });
        expect(result).toEqual({ state: "otp_required" });
        expect(calls).toContain(`embed:click ${SUBMIT_BUTTON}`);
        expect(calls).not.toContain(`click ${SUBMIT_BUTTON}`);
      });

      it("reads the confirmation off the frame's own URL", async () => {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({}),
          embed: {
            url: ({ tick }) => (tick < 3 ? EMBED_URL : CONFIRMED_EMBED),
            dom: () => formUp("Apply for this job"),
          },
        });
        expect(result).toEqual({ state: "submitted" });
      });

      it("reads it off the parent page's URL while the frame stays where it was", async () => {
        // The other half of Ruling J's URL signal: an embedded board usually navigates its
        // parent on success and tears the iframe down, so reading only `root` would lose it.
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({}),
          url: ({ tick }) =>
            tick < 3
              ? `https://job-boards.greenhouse.io/acme/jobs/${JOB}`
              : `https://job-boards.greenhouse.io/acme/jobs/${JOB}/confirmation`,
          embed: { url: () => EMBED_URL, dom: () => formUp("Apply for this job") },
        });
        expect(result).toEqual({ state: "submitted" });
      });

      it("sees a CAPTCHA that is only in the frame and does not click", async () => {
        const { result, calls } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            dom: () => ({ ...formUp("Apply for this job"), 'iframe[src*="recaptcha"][src*="bframe"]': {} }),
          },
        });
        expect(result).toEqual({ state: "captcha" });
        expect(calls.some((c) => c.includes("click "))).toBe(false);
      });

      /**
       * A reload of the parent page replaces the `Frame` object the script is holding, and
       * the one it holds answers every read with nothing for the rest of the run. Two
       * consecutive empty body reads are the poll's signal to go looking for the replacement;
       * without that it would sit out its whole budget reading a dead frame and report
       * `unknown` on an application that went through.
       */
      it("re-picks the frame a parent reload replaced under it", async () => {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({ [SEL.body]: { text: "Careers at Acme" } }),
          embed: {
            generation: ({ tick }) => (tick < 4 ? 0 : 1),
            url: (at, gen) => (gen === 0 ? EMBED_URL : CONFIRMED_EMBED),
            dom: (at, gen) => (gen === 0 && at.tick < 2 ? formUp("Apply for this job") : {}),
          },
        });
        expect(result).toEqual({ state: "submitted" });
      });

      it("still says unknown when the frame that replaces it confirms nothing either", async () => {
        const { result } = await runScript(generateSubmitScript(JOB), {
          dom: () => ({ [SEL.body]: { text: "Careers at Acme" } }),
          embed: {
            generation: ({ tick }) => (tick < 4 ? 0 : 1),
            url: () => EMBED_URL,
            dom: (at, gen) => (gen === 0 && at.tick < 2 ? formUp("Apply for this job") : {}),
          },
        });
        expect(result.state).toBe("unknown");
      });
    });

    /**
     * Decision 12's other half. The MCP kills a `run_code` request at 60 s and returns
     * nothing at all — no state, no detail, not even the click it already made — so a poll
     * that keeps going costs the whole turn. Two bounds hold it: the 40 s deadline in the
     * loop condition and inside `fieldErrors`, and `nodes.slice(0, 5)`, without which a page
     * showing fifty error nodes would spend 200 s in one tick reading them.
     */
    it("stops polling at its deadline, and reads at most five error nodes a tick", async () => {
      const { result, calls, at } = await runScript(generateSubmitScript(JOB), {
        dom: () => ({
          ...formUp("Working on it…"),
          [SEL.body]: { text: "Working on it…", costMs: 2000 },
          [SEL.errors]: { count: 8, text: "", costMs: 1000 },
        }),
        title: () => "Careers at Acme",
      });
      expect(result.state).toBe("unknown");
      const read = calls.filter((c) => c.startsWith(`innerText ${SEL.errors}`));
      expect(read.length).toBeGreaterThan(0);
      for (const c of read) expect(Number(/\[(\d+)\]$/.exec(c)?.[1]), c).toBeLessThan(5);
      // The stated bound is 48 s: a node the collector's own deadline check lets through
      // costs 6 s of reads, and the `unknown` tail adds 2 s. These nodes are cheaper than
      // that — they carry no `attrs`, so `getAttribute id` + `innerText` + `getAttribute
      // aria-errormessage` is 3 s each and the `<id>-error` lookup never happens — and the
      // run lands at 45 s, up from 42.5 s before the message was followed.
      expect(at.clock).toBeLessThanOrEqual(48000);
    });
  });

  describe("otp", () => {
    const submitted = (text: string) => ({ [SEL.body]: { text } });

    it("types the whole code into the first box when the group auto-advances", async () => {
      const { result, calls } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: ({ clicks }) =>
          clicks === 0
            ? { ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, autoAdvance: true } }
            : submitted("Thank you for applying."),
      });
      expect(result).toEqual({ state: "submitted" });
      expect(calls).toContain(`pressSequentially ${SEL.otpBoxes}`);
      expect(calls.some((c) => c === `fill ${SEL.otpBoxes}[0]`)).toBe(false);
    });

    it("falls back to one character per box when the first box swallows the code", async () => {
      const { result, calls } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: ({ clicks }) =>
          clicks === 0
            ? { ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8 } }
            : submitted("Your application has been submitted."),
      });
      expect(result).toEqual({ state: "submitted" });
      for (let i = 0; i < 8; i++) expect(calls, `box ${i}`).toContain(`fill ${SEL.otpBoxes}[${i}]`);
    });

    it("accepts boxes that upper-case the code as they take it", async () => {
      // The read-back is compared case-insensitively; an exact compare would send this down
      // the per-box fallback and then fail it, reporting a good code as one that did not stick.
      const { result, calls } = await runScript(generateOtpScript("bmchfzge", JOB), {
        dom: ({ clicks }) =>
          clicks === 0
            ? { ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, autoAdvance: true, upperCases: true } }
            : { [SEL.body]: { text: "Thank you for applying." } },
      });
      expect(result).toEqual({ state: "submitted" });
      expect(calls.some((c) => c === `fill ${SEL.otpBoxes}[0]`)).toBe(false);
    });

    it("keeps polling through a blank tick mid-navigation instead of giving up on it", async () => {
      const { result } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: ({ clicks, tick }) => {
          if (clicks === 0) return { ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, autoAdvance: true } };
          if (tick < 2) return { [SEL.body]: { text: "" } };
          return { [SEL.body]: { text: "Thanks for applying!" } };
        },
      });
      expect(result).toEqual({ state: "submitted" });
    });

    it("refuses to submit when the boxes never spell the code", async () => {
      const { result, calls } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        // Every box drops the write, so the read-back stays empty through both paths.
        dom: () => ({ ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, readOnly: true } }),
      });
      expect(result.state).toBe("error");
      expect(String(result.detail)).toContain("code did not stick");
      expect(calls.some((c) => c.startsWith("click role=button"))).toBe(false);
    });

    it("reports a missing security-code group instead of clicking", async () => {
      const { result } = await runScript(generateOtpScript("BMCHFZGE", JOB), { dom: () => formUp("Apply for this job") });
      expect(result).toEqual({ state: "error", detail: "no security-code boxes found" });
    });

    it("rejects a malformed code before it touches the page at all", async () => {
      const { result, calls } = await runScript(generateOtpScript("not a code!", JOB), { dom: () => ({}) });
      expect(result).toEqual({ state: "error", detail: "invalid code" });
      expect(calls).toEqual(["wait 1000"]);
    });

    it("reports a form that vanished with nothing confirming it as an error, never submitted", async () => {
      const { result } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: ({ clicks }) =>
          clicks === 0
            ? { ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, autoAdvance: true } }
            : { [SEL.body]: { text: "Something went wrong." } },
      });
      expect(result.state).toBe("error");
      expect(String(result.detail)).toContain("form gone, nothing confirmed it");
    });

    it("refuses to type the code when the browser is on another job", async () => {
      const { result, calls } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: () => ({ ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, autoAdvance: true } }),
        url: () => "https://job-boards.greenhouse.io/acme/jobs/9999999999",
      });
      expect(result).toEqual({ state: "error", detail: `wrong page: expected job ${JOB}` });
      expect(calls).toEqual(["wait 1000"]);
    });

    it("does not call it submitted when the page said the words before the second click", async () => {
      // The same baseline the submit script takes, on the page that carries the code boxes.
      const JD = "We'll be in touch. Enter the security code we emailed you.";
      const { result } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: () => ({ ...formUp(JD), [SEL.otpBoxes]: { count: 8, autoAdvance: true } }),
      });
      expect(result.state).toBe("error");
      expect(String(result.detail)).toContain("no confirmation after the code");
    });

    /**
     * Decision 12. Untimed, everything this script does before its click — the wait for the
     * boxes, the click, the typing, eight read-backs, eight fallback fills and eight more
     * read-backs — can cost 87 s on a slow group, which is the MCP's whole request and then
     * some: the tool returns nothing and the caller cannot even tell whether the code was
     * typed. A 20 s deadline inside both loops is what turns that into a reported failure.
     */
    it("gives up before the click when the boxes are too slow to read back", async () => {
      const { result, at } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: () => ({ ...formUp("Enter your security code"), [SEL.otpBoxes]: { count: 8, costMs: 5000 } }),
      });
      expect(result.state).toBe("error");
      expect(String(result.detail).startsWith("out of time")).toBe(true);
      expect(at.clock).toBeLessThanOrEqual(26000);
    });

    /**
     * The read-back is the one deadline check that cannot return a result shape: `readBack`
     * returns the string the boxes spell, so a returned `{ state: "error" }` lands in `got`
     * and comes back to the model as `code did not stick: [object Object]` — a rejected code,
     * which it answers by asking for another one, rather than a script that ran out of time.
     * Cheap first-pass reads and cheap-enough fills are what get the run as far as the second
     * read-back with the budget nearly spent, which is where that used to happen.
     */
    it("says it ran out of time, not that the code did not stick, when the second read-back is slow", async () => {
      const { result, at } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: (at) => ({
          ...formUp("Enter your security code"),
          [SEL.otpBoxes]: {
            count: 8,
            readOnly: true,
            // Instant on the first pass, two seconds a box once the fills have run.
            costMs: { inputValue: at.clock < 5000 ? 0 : 2000, fill: 2000 },
          },
        }),
      });
      expect(result.state).toBe("error");
      expect(String(result.detail).startsWith("out of time")).toBe(true);
      expect(String(result.detail)).not.toContain("code did not stick");
      expect(at.clock).toBeLessThanOrEqual(26000);
    });

    it("gives up inside the fallback fills when the boxes never hold the code", async () => {
      // Read-backs are instant here and the fills are not, so the deadline trips in the
      // second of the two loops that carry the check rather than the first.
      const { result, at } = await runScript(generateOtpScript("BMCHFZGE", JOB), {
        dom: () => ({
          ...formUp("Enter your security code"),
          [SEL.otpBoxes]: { count: 8, readOnly: true, costMs: { inputValue: 0, fill: 5000 } },
        }),
      });
      expect(result.state).toBe("error");
      expect(String(result.detail).startsWith("out of time")).toBe(true);
      expect(at.clock).toBeLessThanOrEqual(26000);
    });
  });

  describe("fill", () => {
    const RESUME = "/abs/resume.pdf";

    it("uploads the caller's resume for the resume field and the answer's own path elsewhere", async () => {
      // Uploading the resume PDF as someone's cover letter is worse than uploading nothing.
      const answers: ResolvedAnswer[] = [
        answer({ id: "resume", label: "Resume/CV", type: "input_file", value: "/what/the/model/said.pdf" }),
        answer({ id: "cover_letter", label: "Cover Letter", type: "input_file", value: "/abs/cover.pdf" }),
        answer({ id: "portfolio", label: "Portfolio", type: "input_file", value: "" }),
      ];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () =>
          fillable({
            "input#resume[type=file]": {},
            "input#cover_letter[type=file]": {},
            "input#portfolio[type=file]": {},
            // Both uploads are confirmed by the filename the board renders back.
            [filenameIn("input#resume[type=file]")]: { text: "resume.pdf" },
            [filenameIn("input#cover_letter[type=file]")]: { text: "cover.pdf" },
          }),
      });
      expect(calls).toContain(`upload ${RESUME}`);
      expect(calls).toContain("upload /abs/cover.pdf");
      expect(calls).not.toContain("upload /what/the/model/said.pdf");
      expect(result.filled).toEqual([
        { id: "resume", label: "Resume/CV", value: RESUME },
        { id: "cover_letter", label: "Cover Letter", value: "/abs/cover.pdf" },
      ]);
      expect(result.skipped).toEqual([{ id: "portfolio", label: "Portfolio", reason: "no file path given" }]);
      expect(result.ok).toBe(true);
    });

    it("reports a select that landed on the wrong option instead of claiming it filled", async () => {
      const sel = "input#question_1[role=combobox]";
      const answers = [answer({ id: "question_1", label: "Authorized?", type: "multi_value_single_select", value: "Yes" })];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [singleValueOf(sel)]: { text: "No" } }),
      });
      expect(result.ok).toBe(false);
      expect(result.filled).toEqual([]);
      expect(result.validation_errors).toEqual([
        { id: "question_1", label: "Authorized?", error: "selected 'No' instead of 'Yes'" },
      ]);
    });

    it("accepts a select whose read-back differs only in case", async () => {
      const sel = "input#question_1[role=combobox]";
      const answers = [answer({ id: "question_1", label: "Authorized?", type: "multi_value_single_select", value: "Yes" })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [singleValueOf(sel)]: { text: " YES " } }),
      });
      expect(result.ok).toBe(true);
      expect(result.filled).toEqual([{ id: "question_1", label: "Authorized?", value: "Yes" }]);
      // The react-select dance, once, with real keyboard events — and Tab is the whole of it:
      // an ArrowDown would move off the option react-select focused when the menu opened.
      expect(calls.filter((c) => c === "key ArrowDown")).toHaveLength(0);
      expect(calls.filter((c) => c === "key Tab")).toHaveLength(1);
    });

    it("confirms an option with Tab, never Enter, so a re-run on a filled select cannot submit the form", async () => {
      const sel = "input#question_1[role=combobox]";
      const answers = [answer({ id: "question_1", label: "Authorized?", type: "multi_value_single_select", value: "Yes" })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [singleValueOf(sel)]: { text: "Yes" } }),
      });
      expect(result.filled).toEqual([{ id: "question_1", label: "Authorized?", value: "Yes" }]);
      expect(calls.filter((c) => c === "key Tab")).toHaveLength(1);
      expect(calls.filter((c) => c === "key Enter")).toHaveLength(0);
    });

    /**
     * Live on `job-boards.greenhouse.io/mozilla/jobs/7947405`: typing `San Francisco` into
     * `#candidate-location` returned six geocoder options with `San Francisco, California,
     * United States` first, and `ArrowDown` + `Tab` committed the *second* one. react-select
     * focuses option 0 the moment the menu opens, so the `ArrowDown` moved off the best
     * match. Every other select has been masked from this because the dance types an exact
     * option label, which usually narrows the menu to a single entry.
     */
    it("takes the option react-select already focused, rather than the one after it", async () => {
      const sel = "input#city[role=combobox]";
      // A menu the typed text does not narrow to one entry: the answer is a prefix of the second.
      const OPTIONS = ["San Francisco", "San Francisco de Macoris"];
      const answers = [
        answer({ id: "city", label: "Location", type: "multi_value_single_select", value: "San Francisco" }),
      ];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: (at) => {
          const focused = at.keys.filter((k) => k === "ArrowDown").length;
          const took = at.keys.includes("Tab");
          return fillable({
            [sel]: { value: "" },
            [SEL.selectOption]: { count: OPTIONS.length },
            [singleValueOf(sel)]: { text: took ? OPTIONS[Math.min(focused, OPTIONS.length - 1)] : "" },
          });
        },
      });
      expect(result.filled).toEqual([{ id: "city", label: "Location", value: "San Francisco" }]);
      expect(result.validation_errors).toEqual([]);
      expect(calls.filter((c) => c === "key ArrowDown")).toHaveLength(0);
      expect(calls.filter((c) => c === "key Tab")).toHaveLength(1);
    });

    /**
     * The same live run timed the geocoder: the menu was empty at +605 ms and populated at
     * +1,009 ms. A fixed 300 ms pause tabs through nothing; polling for the options is what
     * makes the dance wait as long as the round trip actually takes.
     */
    it("polls for the menu instead of sleeping a fixed pause", async () => {
      const sel = "input#q[role=combobox]";
      // The fill loop is reached at 2,500 ms of fake clock — the pick's second and the settle's
      // 1.5 — so a menu that opens a second after the typing lands opens at 3,500 ms.
      const OPENS = 3500;
      const answers = [answer({ id: "q", label: "Eligible?", type: "multi_value_single_select", value: "Yes" })];
      const { result, calls, at } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: (at) => fillable({
          [sel]: { value: "" },
          [SEL.selectOption]: { count: at.clock >= OPENS ? 2 : 0 },
          // Nothing is committed by a Tab pressed at a menu that has not opened yet.
          [singleValueOf(sel)]: { text: at.clock >= OPENS ? "Yes" : "" },
        }),
      });
      expect(result.filled).toEqual([{ id: "q", label: "Eligible?", value: "Yes" }]);
      expect(calls.filter((c) => c === "wait 250").length).toBeGreaterThan(1);
      expect(at.clock).toBeGreaterThanOrEqual(OPENS);
    });

    /**
     * Decision 14's no-Enter rule, on the path that tempts it most: the poll runs out, nothing
     * is focused, and the only key the script may still press is the one that cannot submit.
     * The bounded poll is what keeps that inside the fill's deadline rather than hanging.
     */
    it("gives up on a menu that never opens without pressing a key that could submit", async () => {
      const sel = "input#q[role=combobox]";
      const answers = [answer({ id: "q", label: "Eligible?", type: "multi_value_single_select", value: "Yes" })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({
          [sel]: { value: "" },
          [SEL.selectOption]: { count: 0 },
          [singleValueOf(sel)]: { text: "" },
        }),
      });
      expect(result.ok).toBe(false);
      expect(String((result.validation_errors as FieldError[])[0].error)).toMatch(/selected/);
      expect(calls.filter((c) => c === "key Enter")).toHaveLength(0);
    });

    it("runs the dance once per value on a multi-select and checks every label came back", async () => {
      const sel = "input#skills[role=combobox]";
      const answers = [answer({ id: "skills", label: "Skills", type: "multi_value_multi_select", value: ["Ada", "Erlang"] })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [multiValuesOf(sel)]: { texts: ["Ada", "Erlang"] } }),
      });
      expect(result.filled).toEqual([{ id: "skills", label: "Skills", value: ["Ada", "Erlang"] }]);
      expect(calls.filter((c) => c === "key Tab")).toHaveLength(2);
    });

    it("fills a multi-select whose id carries the [] suffix through the attribute selector", async () => {
      // Datadog's "In what cities…" question: the brackets are part of the DOM id, so the
      // whole dance has to run off `[id="…"]` rather than off `#…`.
      const sel = 'input[id="question_67918863[]"][role=combobox]';
      const answers = [answer({ id: "question_67918863[]", label: "Cities", type: "multi_value_multi_select", value: ["Amsterdam", "Atlanta"] })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [multiValuesOf(sel)]: { texts: ["Amsterdam", "Atlanta"] } }),
      });
      expect(result.filled).toEqual([{ id: "question_67918863[]", label: "Cities", value: ["Amsterdam", "Atlanta"] }]);
      expect(calls.filter((c) => c === "key Tab")).toHaveLength(2);
    });

    it("reports a multi-select that dropped one of its labels", async () => {
      const sel = "input#skills[role=combobox]";
      const answers = [answer({ id: "skills", label: "Skills", type: "multi_value_multi_select", value: ["Ada", "Erlang"] })];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "" }, [multiValuesOf(sel)]: { texts: ["Ada"] } }),
      });
      expect(result.ok).toBe(false);
      expect(String((result.validation_errors as FieldError[])[0].error)).toBe("selected 'Ada' instead of 'Ada, Erlang'");
    });

    /**
     * A deadline crossed *between* two options of the same multi-select used to report `out
     * of time` twice: the in-loop check called `bad()` and broke, and the post-loop check —
     * which is the one place that should report and flag the field — called `bad()` again on
     * the same field, because `over()` is monotone and stays true. The two statements arrived
     * in different commits, which is why a per-commit review never saw them collide.
     *
     * `click`'s cost is what crosses the deadline mid-loop: the first option's click spends
     * 31 s of fake clock, so the loop is under budget when it starts processing "Ada" and over
     * it by the time it reaches "Erlang".
     */
    it("reports a select the deadline truncated between two options as out of time exactly once", async () => {
      const sel = "input#skills[role=combobox]";
      const answers = [answer({ id: "skills", label: "Skills", type: "multi_value_multi_select", value: ["Ada", "Erlang"] })];
      const { result, at } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ [sel]: { value: "", costMs: { click: 31000 } } }),
      });
      expect(at.clock).toBeGreaterThan(30000);
      expect(result.reason).toBe("deadline");
      expect(result.ok).toBe(false);
      expect(result.filled).toEqual([]);
      expect(result.validation_errors).toEqual([{ id: "skills", label: "Skills", error: "out of time" }]);
    });

    /**
     * An `unlisted_select` is a react-select whose options the Job Board API does not
     * enumerate — the `Location (City)` type-ahead over Greenhouse's geocoder. Live on
     * `job-boards.greenhouse.io/mozilla/jobs/7947405`, typing `San Francisco` resolves to
     * `San Francisco, California, United States`, so the read-back can only be containment:
     * the answer is a substring of what the control ends up holding, never the reverse.
     */
    describe("a select whose options the API does not enumerate", () => {
      const LOCATION = "input#candidate-location[role=combobox]";
      const asked = (value: string): ResolvedAnswer[] => [
        answer({ id: "candidate-location", label: "Location (City)", type: "unlisted_select", source: "location", value }),
      ];

      it("fills one and reports the fuller wording the geocoder resolved to", async () => {
        const { result, calls } = await runScript(generateFillScript(asked("San Francisco"), RESUME, JOB), {
          dom: () => fillable({
            [LOCATION]: { value: "" },
            [singleValueOf(LOCATION)]: { text: "San Francisco, California, United States" },
          }),
        });
        // What is reported is what the page actually holds, so the model can see which city
        // Greenhouse picked and stop to ask when that is the wrong one.
        expect(result.filled).toEqual([
          { id: "candidate-location", label: "Location (City)", value: "San Francisco, California, United States" },
        ]);
        expect(result.validation_errors).toEqual([]);
        // The text/select fork is `a.type.indexOf("select") < 0`, so this type takes the
        // dance — true only until someone renames it, which is why it is asserted here
        // rather than read off the template.
        expect(calls.filter((c) => c === "key Tab")).toHaveLength(1);
        expect(calls.filter((c) => c === "key Enter")).toHaveLength(0);
      });

      it("reports one whose resolved value has nothing to do with the answer", async () => {
        const { result } = await runScript(generateFillScript(asked("San Francisco"), RESUME, JOB), {
          dom: () => fillable({
            [LOCATION]: { value: "" },
            [singleValueOf(LOCATION)]: { text: "Reykjavik, Iceland" },
          }),
        });
        expect(result.ok).toBe(false);
        expect(result.filled).toEqual([]);
        expect(String((result.validation_errors as FieldError[])[0].error)).toMatch(/San Francisco/);
      });

      it("reports one the board does not render as skipped, not as an error", async () => {
        // Decision 13: a control that is not on the page costs a `skipped` line, never a
        // blocking error — true of an unlisted select the same as any other question type.
        const answers = [
          answer({ id: "candidate-location", label: "Location (City)", type: "unlisted_select", source: "location", value: "San Francisco" }),
        ];
        const { result } = await runScript(generateFillScript(answers, RESUME, JOB), { dom: () => fillable({}) });
        expect(result.skipped).toEqual([{ id: "candidate-location", label: "Location (City)", reason: "not on page" }]);
        expect(result.filled).toEqual([]);
        expect(result.validation_errors).toEqual([]);
        expect(result.ok).toBe(true);
      });
    });

    /**
     * Some boards render a `multi_value_multi_select` as a group of checkboxes sharing one
     * `name` rather than as a react-select — amplitude's "How did you hear about us?" is one.
     * The react-select stays the preferred path; the group is reached only when the combobox
     * is not in the DOM at all.
     */
    describe("a [] multi-select the board renders as a checkbox group", () => {
      const ID = "question_68440829[]";
      const LABEL = "How did you hear about us?";
      const SOURCES = ["Careers Website", "LinkedIn", "Glassdoor"];
      const asked = (value: string[]): ResolvedAnswer[] => [
        answer({ id: ID, label: LABEL, type: "multi_value_multi_select", value }),
      ];

      it("checks the boxes the answer names and leaves the rest alone", async () => {
        const { result, at, calls } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable(checkboxGroup(ID, SOURCES)),
        });
        expect(result.filled).toEqual([{ id: ID, label: LABEL, value: ["LinkedIn"] }]);
        expect(result.skipped).toEqual([]);
        expect(result.validation_errors).toEqual([]);
        // The LinkedIn box, by its own id: the other two are read and passed over.
        expect(at.checked).toEqual([boxOf(ID, 1)]);
        // A checkbox takes no keyboard dance at all.
        expect(calls.filter((c) => c.startsWith("key "))).toEqual([]);
      });

      it("checks every box a multi-value answer names", async () => {
        const { result, at } = await runScript(generateFillScript(asked(["Careers Website", "Glassdoor"]), RESUME, JOB), {
          dom: () => fillable(checkboxGroup(ID, SOURCES)),
        });
        expect(result.filled).toEqual([{ id: ID, label: LABEL, value: ["Careers Website", "Glassdoor"] }]);
        expect(at.checked).toEqual([boxOf(ID, 0), boxOf(ID, 2)]);
      });

      it("is safe to re-run against a group that already holds its answer", async () => {
        // Decision 14: every fill path has to survive a second run over a form it already
        // filled. `check()` is idempotent, which is the whole of why this one does.
        const { result, at, calls } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable(checkboxGroup(ID, SOURCES, [`${ID}_1`])),
        });
        expect(result.filled).toEqual([{ id: ID, label: LABEL, value: ["LinkedIn"] }]);
        expect(result.validation_errors).toEqual([]);
        expect(at.checked).toEqual([boxOf(ID, 1)]);
        expect(calls.filter((c) => c === "key Enter")).toHaveLength(0);
      });

      it("names the options it could not find in the group", async () => {
        // Naming the option is what lets the model recover without re-reading the form, so
        // the error carries both halves: what was checked, and what was asked for.
        const { result } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable(checkboxGroup(ID, ["Careers Website"])),
        });
        expect(result.ok).toBe(false);
        expect(result.filled).toEqual([]);
        expect(result.validation_errors).toEqual([
          { id: ID, label: LABEL, error: "checked '' instead of 'LinkedIn'" },
        ]);
        expect(String((result.validation_errors as FieldError[])[0].error)).toMatch(/LinkedIn/);
      });

      it("prefers the react-select when the board renders one, and never touches the group", async () => {
        const sel = `input[id="${ID}"][role=combobox]`;
        const { result, at } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable({
            [sel]: { value: "" },
            [multiValuesOf(sel)]: { texts: ["LinkedIn"] },
            ...checkboxGroup(ID, SOURCES),
          }),
        });
        expect(result.filled).toEqual([{ id: ID, label: LABEL, value: ["LinkedIn"] }]);
        expect(at.checked).toEqual([]);
      });

      it("reports a question the board renders neither way as skipped", async () => {
        const { result } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable({}),
        });
        expect(result.skipped).toEqual([{ id: ID, label: LABEL, reason: "not on page" }]);
        expect(result.validation_errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      /**
       * A deadline that truncates the group is `out of time`, never a mismatch.
       *
       * The two messages tell the model opposite things. `out of time` — with `late`, and so
       * `reason: "deadline"` — says the answer was never typed, so re-run this script once and
       * then stop and ask. A `checked '…' instead of '…'` says the answer itself is wrong, and
       * sends the model off fixing an answer that was fine, on the one branch whose whole
       * purpose is cutting turns.
       *
       * The group is the *only* answer here, which is the arrangement that makes the bug
       * observable: with anything after it, `over()` is rechecked at the top of the next pass
       * of the answers loop (or of the text read-back pass) and sets `late` anyway. Checkbox
       * groups — consent acknowledgements, "how did you hear about us" — commonly sit last on
       * a Greenhouse form, so this is exactly where a real one lands.
       */
      it("reports a group its deadline truncated as out of time, not as a mismatch", async () => {
        // The answers loop is reached at 2,500 ms; reading the first box's id then costs
        // 28,000, which puts the second pass past the 30 s line with nothing checked yet.
        const { result, at } = await runScript(generateFillScript(asked(["LinkedIn"]), RESUME, JOB), {
          dom: () => fillable({
            ...checkboxGroup(ID, SOURCES),
            [boxOf(ID, 0)]: { attrs: { id: `${ID}_0` }, costMs: { getAttribute: 28000 } },
          }),
        });
        expect(at.clock).toBeGreaterThan(30000);
        expect(result.reason).toBe("deadline");
        expect(result.ok).toBe(false);
        expect(result.filled).toEqual([]);
        expect(at.checked).toEqual([]);
        expect(result.validation_errors).toEqual([{ id: ID, label: LABEL, error: "out of time" }]);
        // The wording the select loop uses for the same thing, and not the confirmation
        // comparison's — which would read `checked '' instead of 'LinkedIn'`.
        expect(String((result.validation_errors as FieldError[])[0].error)).not.toMatch(/instead of/);
      });
    });

    it("loses one field the board does not render and fills the rest", async () => {
      // Decision 13: a field that is not there is `skipped`, not a validation error and not a
      // five-second timeout. The `race` question on Datadog's embed was exactly this — in the
      // API schema, never in the DOM — and it cost a `locator.click` timeout to find out.
      const answers = [
        answer({ id: "first_name", label: "First Name", value: "Jane" }),
        answer({ id: "gone", label: "Vanished", value: "Nobody" }),
        answer({ id: "last_name", label: "Last Name", value: "Placeholder" }),
      ];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({
          "input#first_name": {},
          "input#gone": { throws: "element is not attached to the DOM" },
          "input#last_name": {},
        }),
      });
      expect((result.filled as FilledField[]).map((f) => f.id)).toEqual(["first_name", "last_name"]);
      expect(result.skipped).toEqual([{ id: "gone", label: "Vanished", reason: "not on page" }]);
      expect(result.validation_errors).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("clips a long answer out of the result it echoes back", async () => {
      const answers = [answer({ id: "cover", label: "Cover Letter", type: "textarea", value: "x".repeat(2000) })];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ "textarea#cover": {} }),
      });
      expect((result.filled as FilledField[])[0].value).toHaveLength(120);
    });

    it("never touches #country, because there is no country question to answer it with", async () => {
      // `input#country[role=combobox]` is real DOM on plenty of boards, but it is the phone
      // widget's dial-code selector, not an address field: its only "United States" option
      // reads "United States +1", and picking it reformats `phone`. A synthesised `country`
      // question once aimed the fill at that control (and a hardcoded `#country` probe before
      // it); both are gone, so a result carries nothing but the answers it was actually
      // handed, and a `#country` present in the DOM is left exactly as it was found.
      const answers = [answer({ id: "first_name", label: "First Name", value: "Jane" })];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({ "input#first_name": {}, "input#country[role=combobox]": {} }),
      });
      expect(result).toEqual({
        ok: true,
        filled: [{ id: "first_name", label: "First Name", value: "Jane" }],
        skipped: [],
        validation_errors: [],
        frame: null,
      });
    });

    /**
     * I3. `setInputFiles` resolves as soon as the file is attached to the input, which is not
     * the same as Greenhouse having taken it: the page POSTs the bytes to S3 and only then
     * renders a `.file-upload__filename` node in place of the input. Reporting `filled` off
     * the attach alone is the optimistic row that made a failed upload look like an attached
     * resume — and `filled[]` is exactly what the caller reads before it submits.
     *
     * Decision 14: an attach Greenhouse was not ready for is retried, so "not confirmed yet"
     * and "never confirmed" are different outcomes and both are pinned here.
     */
    describe("an upload the page confirms late, or never", () => {
      const FILE = "input#resume[type=file]";
      const resumeOnly = [answer({ id: "resume", label: "Resume/CV", type: "input_file", value: "" })];

      it("reports filled once the field's own wrapper names the file", async () => {
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {}, [filenameIn(FILE)]: { text: "resume.pdf" } }),
        });
        expect(calls).toContain(`upload ${RESUME}`);
        expect(result.filled).toEqual([{ id: "resume", label: "Resume/CV", value: RESUME }]);
        expect(result.validation_errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("falls back to the whole page for a board that renders the name outside the wrapper", async () => {
        const { result } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {}, [SEL.uploadFilename]: { text: "Attached: resume.pdf" } }),
        });
        expect(result.filled).toEqual([{ id: "resume", label: "Resume/CV", value: RESUME }]);
        expect(result.ok).toBe(true);
      });

      it("reports the upload as unconfirmed when no filename node ever appears", async () => {
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {} }),
        });
        expect(calls).toContain(`upload ${RESUME}`);
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(3);
        expect(result.filled).toEqual([]);
        expect(result.validation_errors).toEqual([
          { id: "resume", label: "Resume/CV", error: "upload not confirmed" },
        ]);
        expect(result.ok).toBe(false);
      });

      it("reports it unconfirmed when the name on the page belongs to another file", async () => {
        // The previous field's filename is still on screen; it is not evidence for this one.
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {}, [SEL.uploadFilename]: { text: "cover-letter.pdf" } }),
        });
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(3);
        expect(result.validation_errors).toEqual([
          { id: "resume", label: "Resume/CV", error: "upload not confirmed" },
        ]);
        expect(result.ok).toBe(false);
      });

      it("retries an attach the page was not ready for, and confirms it on the second attempt", async () => {
        // Greenhouse's uploaders map is filled by an async presigned_fields fetch; a change
        // event before it lands throws inside Greenhouse's handler and nothing is uploaded.
        // The live Datadog run hit exactly that. A second attach a second later goes through.
        const atOnce = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {}, [filenameIn(FILE)]: { text: "resume.pdf" } }),
        });
        const { result, calls, at } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: (at) => fillable({ [FILE]: {}, ...(at.uploads >= 2 ? { [filenameIn(FILE)]: { text: "resume.pdf" } } : {}) }),
        });
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(2);
        // Two: the re-pick's own second chance for a slow embed (REPICK), and the retry's pause.
        expect(calls.filter((c) => c === "wait 1000")).toHaveLength(2);
        expect(result.filled).toEqual([{ id: "resume", label: "Resume/CV", value: RESUME }]);
        expect(result.ok).toBe(true);
        // The retry costs exactly the two 1.5 s misses (wrapper, then page) and the 1 s pause
        // more than a first-time confirmation; everything else (re-pick wait, settle hold) is
        // the same in both runs, so the difference is the number that matters.
        expect(at.clock - atOnce.at.clock).toBe(4000);
      });

      it("reports an already-attached file as filled when the input is gone but the filename stands", async () => {
        // A fill re-run over a resume Greenhouse has already taken: it unmounts the input the
        // instant an attach lands, so the attach throws and costs its own 5 s timeout. The
        // filename node the page still shows is the evidence, and one attempt is enough.
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [filenameIn(FILE)]: { text: "resume.pdf" } }),
        });
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(0);
        expect(result.filled).toEqual([{ id: "resume", label: "Resume/CV", value: RESUME }]);
        expect(result.validation_errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("gives up after three attaches and quotes the field's own error", async () => {
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({
            [FILE]: {},
            [`${FILE} >> ${SEL.uploadWrapper} >> [id$="-error"]`]: { text: "Cannot read properties of undefined (reading 'uploadFile')" },
          }),
        });
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(3);
        expect(result.validation_errors).toEqual([
          { id: "resume", label: "Resume/CV", error: "upload not confirmed: Cannot read properties of undefined (reading 'uploadFile')" },
        ]);
        expect(result.ok).toBe(false);
      });

      it("does not retry an attach once the deadline has passed", async () => {
        const { result, calls } = await runScript(generateFillScript(resumeOnly, RESUME, JOB), {
          dom: () => fillable({ [FILE]: { costMs: { setInputFiles: 29_000 } } }),
        });
        expect(calls.filter((c) => c === `upload ${RESUME}`)).toHaveLength(1);
        expect(result.validation_errors).toEqual([{ id: "resume", label: "Resume/CV", error: "upload not confirmed" }]);
      });

      it("attaches files after every other field, whatever order the answers came in", async () => {
        const sel = "input#question_1[role=combobox]";
        const answers = [
          answer({ id: "resume", label: "Resume/CV", type: "input_file", value: "" }),
          answer({ id: "first_name", label: "First Name", value: "Jane" }),
          answer({ id: "question_1", label: "Authorized?", type: "multi_value_single_select", value: "Yes" }),
        ];
        const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
          dom: () => fillable({
            "input#first_name": { value: "" }, [sel]: { value: "" }, [singleValueOf(sel)]: { text: "Yes" },
            [FILE]: {}, [filenameIn(FILE)]: { text: "resume.pdf" },
          }),
        });
        const order = calls.filter((c) => c.startsWith("fill ") || c.startsWith("upload "));
        expect(order.indexOf(`upload ${RESUME}`)).toBe(order.length - 1);
        expect((result.filled as FilledField[]).map((f) => f.id)).toEqual(["first_name", "question_1", "resume"]);
      });
    });

    /**
     * I2. The `<name>_text` twin is not in the DOM until the applicant asks for it:
     * Greenhouse renders the drop zone with an "Enter manually" button and mounts the
     * textarea only on click. A fill script that just types into `textarea#resume_text`
     * fails on every board that hides it, which is all of them.
     */
    describe("a twin textarea that mounts only after Enter manually", () => {
      const FILE = "input#resume[type=file]";
      const TWIN = "textarea#resume_text";
      const twin = [
        answer({
          id: "resume_text",
          label: "Resume/CV",
          type: "textarea",
          value: "Ada Lovelace, Analytical Engines.",
          twinOf: "resume",
        }),
      ];

      it("clicks the button in the twin's own field group, then fills the textarea it mounts", async () => {
        const { result, calls } = await runScript(generateFillScript(twin, RESUME, JOB), {
          dom: (at) =>
            fillable({
              [FILE]: {},
              [manualIn(FILE)]: {},
              // The textarea exists only once that button has been clicked.
              ...(at.clicked.includes(manualIn(FILE)) ? { [TWIN]: {} } : {}),
            }),
        });
        expect(calls).toContain(`click ${manualIn(FILE)}`);
        expect(result.filled).toEqual([
          { id: "resume_text", label: "Resume/CV", value: "Ada Lovelace, Analytical Engines." },
        ]);
        expect(result.ok).toBe(true);
      });

      it("falls back to the first Enter manually button on the page when the group lookup misses", async () => {
        const { result, calls } = await runScript(generateFillScript(twin, RESUME, JOB), {
          dom: (at) =>
            fillable({
              [FILE]: {},
              [SEL.manualButton]: {},
              ...(at.clicked.includes(SEL.manualButton) ? { [TWIN]: {} } : {}),
            }),
        });
        expect(calls).toContain(`click ${SEL.manualButton}`);
        expect(result.ok).toBe(true);
        expect((result.filled as FilledField[])[0].id).toBe("resume_text");
      });

      it("loses the field to one validation error when there is no such button anywhere", async () => {
        const other = answer({ id: "first_name", label: "First Name", value: "Jane" });
        const { result } = await runScript(generateFillScript([...twin, other], RESUME, JOB), {
          dom: () => ({ [FILE]: {}, "input#first_name": {} }),
        });
        expect(result.validation_errors).toHaveLength(1);
        expect((result.validation_errors as FieldError[])[0].id).toBe("resume_text");
        // The loop carried on: the field after the twin was still filled.
        expect((result.filled as FilledField[]).map((f) => f.id)).toEqual(["first_name"]);
        expect(result.ok).toBe(false);
      });

      it("types straight into a twin that is already mounted, without clicking anything", async () => {
        const { result, calls } = await runScript(generateFillScript(twin, RESUME, JOB), {
          dom: () => fillable({ [FILE]: {}, [TWIN]: {} }),
        });
        expect(calls.some((c) => c.startsWith("click"))).toBe(false);
        expect(result.ok).toBe(true);
      });
    });

    /** Ruling P, on the fill side: nothing is typed anywhere until the URL says it may be. */
    it("refuses to touch a single field when the browser is on another job", async () => {
      const answers = [answer({ id: "first_name", label: "First Name", value: "Jane" })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({ "input#first_name": {} }),
        url: () => "https://job-boards.greenhouse.io/acme/jobs/9999999999",
      });
      expect(result).toEqual({
        ok: false,
        filled: [],
        skipped: [],
        validation_errors: [],
        reason: `wrong page: expected job ${JOB}`,
        frame: null,
      });
      expect(calls).toEqual(["wait 1000"]);
    });

    /**
     * The outer catch's `bail(why(e))` used to reference `why`/`bail` from a `const` the try
     * block declared for itself — invisible to the catch's own block scope, so any throw
     * before that line ran (here, `page.url()` itself throwing inside the guard) surfaced as
     * an unhandled `ReferenceError: bail is not defined` instead of a reported failure. A
     * scenario whose `url()` throws synchronously exercises exactly that path.
     */
    it("resolves rather than rejects when page.url() itself throws", async () => {
      const answers = [answer({ id: "first_name", label: "First Name", value: "Jane" })];
      const { result } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({ "input#first_name": {} }),
        url: () => {
          throw new Error("boom");
        },
      });
      expect(result).toEqual({
        ok: false,
        filled: [],
        skipped: [],
        validation_errors: [],
        reason: "boom",
        frame: null,
      });
    });

    /**
     * Decision 12. On a company-hosted board the whole form lives in a
     * `greenhouse.io/embed/job_app` iframe. Every locator the fill builds has to be built on
     * that frame: the first live run on one of these boards used `page.` throughout, matched
     * nothing, and spent its whole request timing out one selector at a time.
     */
    describe("a form rendered inside the Greenhouse embed", () => {
      const FILE = "input#resume[type=file]";
      const SELECT = "input#question_1[role=combobox]";
      const embedded: ResolvedAnswer[] = [
        answer({ id: "first_name", label: "First Name", value: "Jane" }),
        answer({ id: "last_name", label: "Last Name", value: "Placeholder" }),
        answer({ id: "resume", label: "Resume/CV", type: "input_file", value: "" }),
        answer({ id: "question_1", label: "Authorized?", type: "multi_value_single_select", value: "Yes" }),
      ];
      /** One text answer, for the scenarios that are about the frame rather than the form. */
      const one = [answer({ id: "question_1", label: "Why us?", value: "Because." })];
      const embedDom = () =>
        fillable({
          "input#first_name": {},
          "input#last_name": {},
          [FILE]: {},
          [filenameIn(FILE)]: { text: "resume.pdf" },
          [SELECT]: { value: "" },
          [singleValueOf(SELECT)]: { text: "Yes" },
        });

      it("fills every field in the frame and names the frame it worked in", async () => {
        const { result, calls } = await runScript(generateFillScript(embedded, RESUME, JOB), {
          dom: () => ({}),
          embed: { url: () => EMBED_URL, dom: embedDom },
        });
        expect(result.ok).toBe(true);
        // Decision 14: the resume is attached last however the answers were ordered.
        expect((result.filled as FilledField[]).map((f) => f.id)).toEqual([
          "first_name",
          "last_name",
          "question_1",
          "resume",
        ]);
        expect(result.frame).toBe(EMBED_URL);
        // Nothing was typed, clicked or uploaded anywhere but in the frame.
        const actions = calls.filter((c) => /^(?:embed:)?(?:fill|click|setInputFiles|upload) /.test(c));
        expect(actions.length).toBeGreaterThan(0);
        for (const c of actions) expect(c, c).toMatch(/^embed:/);
      });

      /**
       * The embed is a frame the parent mounts, so it is often not in `page.frames()` when
       * the script starts. One re-pick after a second covers the usual case; the anchor loop
       * re-picks twice more, which is what this exercises.
       */
      it("re-picks the root when the frame is still mounting", async () => {
        const { result, calls } = await runScript(generateFillScript(embedded, RESUME, JOB), {
          dom: () => ({}),
          frames: ({ clock }) => clock >= 4000,
          embed: { url: () => EMBED_URL, dom: embedDom },
        });
        expect(result.ok).toBe(true);
        expect(result.frame).toBe(EMBED_URL);
        // The page's own anchor attempt failed first, and only then did the frame arrive.
        expect(calls.slice(0, 3)).toEqual(["wait 1000", `waitFor ${ANCHOR}`, `embed:waitFor ${ANCHOR}`]);
      });

      /**
       * Ruling P as Decision 12 amends it: a careers page is free to say nothing about the
       * job in its own URL, and the embed's `token=` is then the only place the id appears.
       */
      describe("a careers page whose own URL carries no job id", () => {
        const oneField = () => fillable({ "input#question_1": {} });

        it("fills the form when the frame's token names the job", async () => {
          const { result } = await runScript(generateFillScript(one, RESUME, JOB), {
            dom: () => ({}),
            url: () => "https://careers.example.com/apply",
            embed: { url: () => EMBED_URL, dom: oneField },
          });
          expect(result.filled).toEqual([{ id: "question_1", label: "Why us?", value: "Because." }]);
          expect(result.frame).toBe(EMBED_URL);
        });

        it("refuses when the frame's token is only a leading substring of the job", async () => {
          const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
            dom: () => ({}),
            url: () => "https://careers.example.com/apply",
            embed: { url: () => `${EMBED_URL}1`, dom: oneField },
          });
          expect(String(result.reason).startsWith("wrong page")).toBe(true);
          expect(calls).toEqual([]);
        });

        it("still fills when the frame only arrives during the re-pick wait", async () => {
          // The guard's `token=` clause is no help until `root` is the frame, which is why
          // the second `pick()` runs before the guard rather than after it.
          const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
            dom: () => ({}),
            url: () => "https://careers.example.com/apply",
            frames: ({ clock }) => clock >= 1000,
            embed: { url: () => EMBED_URL, dom: oneField },
          });
          expect(result.frame).toBe(EMBED_URL);
          expect((result.filled as FilledField[]).map((f) => f.id)).toEqual(["question_1"]);
          expect(calls[0]).toBe("wait 1000");
        });
      });

      /**
       * Decision 13. The anchor being visible is not the form being ready: Greenhouse mounts
       * the markup and React hydrates it afterwards, and whatever was typed in between is
       * thrown away with the old element. The first live run on a hosted board lost its first
       * four fields to exactly that and reported all four as filled. So each attempt holds the
       * anchor's own element handle and requires it to survive 1,500 ms.
       */
      it("re-anchors when the element it settled on is replaced under it", async () => {
        const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            dom: () => ({
              // There when the settle first looks, gone during the hold, back once the
              // remount has finished — and no navigation anywhere in the story.
              [ANCHOR]: { connected: (at) => at.clock < 1000 || at.clock >= 3000 },
              "input#question_1": {},
            }),
          },
        });
        expect(result.ok).toBe(true);
        expect(result.filled).toEqual([{ id: "question_1", label: "Why us?", value: "Because." }]);
        expect(result.frame).toBe(EMBED_URL);
        // Twice: the first attempt settled onto an element that did not survive its own hold.
        expect(calls.filter((c) => c === `embed:waitFor ${ANCHOR}`)).toHaveLength(2);
      });

      /**
       * The anchor is visible, and then it is not there to be held. An uncaught rejection on
       * the handle grab reported a Playwright timeout string as the whole fill's `reason`,
       * with no frame list, and left settle attempts 2 and 3 unspent — a disconnect has to
       * cost the attempt and nothing more, whichever call notices it.
       */
      it("spends one settle attempt on an anchor that detaches before it can be held", async () => {
        const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            dom: () => ({ [ANCHOR]: { noHandle: (at) => at.clock < 1000 }, "input#question_1": {} }),
          },
        });
        expect(result.ok).toBe(true);
        expect(result.filled).toEqual([{ id: "question_1", label: "Why us?", value: "Because." }]);
        expect(result.frame).toBe(EMBED_URL);
        expect(String(result.reason ?? "")).not.toContain("elementHandle");
        // Two attempts, each reaching the grab: the first failed there, the second settled.
        expect(calls.filter((c) => c === `embed:waitFor ${ANCHOR}`)).toHaveLength(2);
        expect(calls.filter((c) => c === `embed:elementHandle ${ANCHOR}`)).toHaveLength(2);
      });

      it("fills a form that never hydrates, once the hydration budget is spent", async () => {
        const { result, at } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            dom: () => ({ [ANCHOR]: { hydrated: () => false }, "input#question_1": {} }),
          },
        });
        expect(result.ok).toBe(true);
        expect((result.filled as FilledField[]).map((f) => f.id)).toEqual(["question_1"]);
        // 6 s of hydration budget, then the 1,500 ms hold decides on connectedness alone. A
        // page with no React on it is never refused for lack of a fiber key — the fill just
        // waits out the budget and gets on with it.
        expect(at.clock).toBe(7500);
      });

      /**
       * The settle spends from the same 30 s budget the answers loop checks, and is not
       * checked against it: a form that has not settled is not a form to type into, whatever
       * the clock says. So a form that takes three attempts to settle can leave nothing for
       * the fill — and that has to come back as `deadline` with an honest empty `filled`,
       * not as a fill that quietly did nothing.
       */
      it("reports a deadline, having typed nothing, when settling used the whole budget", async () => {
        const three = ["first", "second", "third"].map((id) => answer({ id, label: id, value: "x" }));
        const { result, at } = await runScript(generateFillScript(three, RESUME, JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            // Four seconds to see the anchor each time, and it only stays connected once the
            // budget is gone: two attempts fail the hold, the third settles at 32 s.
            dom: () => ({
              [ANCHOR]: { costMs: { waitFor: 4000 }, connected: (at) => at.clock > 30000 },
            }),
          },
        });
        expect(result.reason).toBe("deadline");
        expect(result.ok).toBe(false);
        expect(result.filled).toEqual([]);
        expect((result.skipped as SkippedField[]).map((x) => [x.id, x.reason])).toEqual([
          ["first", "out of time"],
          ["second", "out of time"],
          ["third", "out of time"],
        ]);
        // 3 × (4,000 anchor + 6,000 hydration budget + 1,500 hold) is 34,500 at worst; here
        // the third attempt's wait ends early, at 30,500, so the fill starts at 32,000 with
        // its deadline already past and nothing left to do but skip every answer.
        expect(at.clock).toBe(32000);
      });

      it("says the form never settled, which is not the same as never finding one", async () => {
        const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => ({}),
          embed: {
            url: () => EMBED_URL,
            // Always there to be found, never there a second and a half later.
            dom: () => ({ [ANCHOR]: { connected: (at) => at.clock < 500 }, "input#question_1": {} }),
          },
        });
        expect(result.reason).toBe("form not settled");
        expect(result.ok).toBe(false);
        // The same frame list `form not found` carries, because it is the same question a
        // human asks next — but a different answer to "was there a form at all?".
        expect(result.frames).toEqual([`https://job-boards.greenhouse.io/acme/jobs/${JOB}`, EMBED_URL]);
        expect(calls.some((c) => c.includes("fill "))).toBe(false);
      });
    });

    /**
     * The anchor. Thirty selectors that each time out against a page with no form on it is
     * the shape of the failure this replaces: three tries at four seconds, re-picking the
     * root between them, and then a result that names every frame the page was showing so a
     * human can see where the form actually was.
     */
    it("refuses to touch anything when no document has the form, and lists the frames", async () => {
      const answers = [answer({ id: "first_name", label: "First Name", value: "Jane" })];
      const { result, calls, at } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({}),
        embed: { url: () => EMBED_URL, dom: () => ({}) },
      });
      expect(result.ok).toBe(false);
      expect(String(result.reason).startsWith("form not found")).toBe(true);
      expect(result.frames).toEqual([`https://job-boards.greenhouse.io/acme/jobs/${JOB}`, EMBED_URL]);
      // Three attempts, all in the frame `pick()` chose, and not one field touched.
      expect(calls).toEqual([`embed:waitFor ${ANCHOR}`, `embed:waitFor ${ANCHOR}`, `embed:waitFor ${ANCHOR}`]);
      expect(at.clock).toBe(12000);
    });

    /**
     * The deadline. The MCP kills the request at 60 s and returns nothing at all — not even
     * the fields that were filled before it did — so the script stops at 30 s and reports
     * what it has: `deadline`, the fields it reached, and the ones it never got to.
     */
    it("stops at its deadline and reports the fields it never reached", async () => {
      const answers = Array.from({ length: 12 }, (_, i) =>
        answer({ id: `question_${i}`, label: `Question ${i}` }),
      );
      const slow: Record<string, FakeNode> = {};
      for (const a of answers) slow[a.selector] = { costMs: { fill: 5000 } };
      const { result, at } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => ({}),
        embed: { url: () => EMBED_URL, dom: () => fillable(slow) },
      });
      expect(result.reason).toBe("deadline");
      expect(result.ok).toBe(false);
      // 1,500 ms settling, then six fields at 5 s each — the seventh check falls at 31,500 ms,
      // past the 30 s line, so the last six are never attempted and nothing follows.
      expect((result.filled as FilledField[]).map((f) => f.id)).toEqual([
        "question_0",
        "question_1",
        "question_2",
        "question_3",
        "question_4",
        "question_5",
      ]);
      expect((result.skipped as SkippedField[]).map((x) => x.id)).toEqual([
        "question_6",
        "question_7",
        "question_8",
        "question_9",
        "question_10",
        "question_11",
      ]);
      for (const x of result.skipped as SkippedField[]) expect(x.reason).toBe("out of time");
      expect(at.clock).toBe(31500);
    });

    /**
     * Decision 13. `filled[]` used to be intent: the text branch recorded a field the instant
     * `el.fill()` resolved and never looked again. The first live run on a company-hosted
     * board reported four text fields filled that an independent read-back found empty half a
     * minute later — the form had been remounted underneath the script. Every text field is
     * now read back, refilled once, and read again before it may stay in `filled`.
     */
    describe("a text field the page does not keep", () => {
      const one = [answer({ id: "first_name", label: "First Name", value: "Jane" })];

      it("refills a field the page wiped once, and keeps it in filled", async () => {
        const { result, calls } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => fillable({ "input#first_name": { wipeReads: 1 } }),
        });
        expect(result.filled).toEqual([{ id: "first_name", label: "First Name", value: "Jane" }]);
        expect(result.validation_errors).toEqual([]);
        expect(result.ok).toBe(true);
        // Typed twice: once by the answers loop, once by the confirmation that follows it.
        expect(calls.filter((c) => c === "fill input#first_name")).toHaveLength(2);
      });

      it("moves a field that never holds its value out of filled and into validation_errors", async () => {
        const { result } = await runScript(generateFillScript(one, RESUME, JOB), {
          dom: () => fillable({ "input#first_name": { wipeReads: 2 } }),
        });
        expect(result.filled).toEqual([]);
        expect(result.validation_errors).toEqual([
          { id: "first_name", label: "First Name", error: "value did not stick" },
        ]);
        expect(result.ok).toBe(false);
      });
    });

    it("spends no more than a second finding out a field is not on the page", async () => {
      // `race` is in Datadog's API schema and was never in its embed's DOM; the click that
      // found that out sat through its own five-second timeout and reported a validation
      // error. The difference between the two runs is the whole cost of the missing field.
      const both = [
        answer({ id: "first_name", label: "First Name", value: "Jane" }),
        answer({ id: "race", label: "Race", type: "multi_value_single_select", value: "Decline" }),
      ];
      const dom = () => fillable({ "input#first_name": {} });
      const withRace = await runScript(generateFillScript(both, RESUME, JOB), { dom });
      const without = await runScript(generateFillScript([both[0]], RESUME, JOB), { dom });
      expect(withRace.result.skipped).toEqual([{ id: "race", label: "Race", reason: "not on page" }]);
      expect(withRace.result.validation_errors).toEqual([]);
      expect(withRace.at.clock - without.at.clock).toBeLessThanOrEqual(1000);
    });

    /** The Greenhouse-hosted board, unchanged apart from the re-pick and the anchor. */
    it("fills a hosted board in the page itself and names no frame", async () => {
      const answers = [answer({ id: "first_name", label: "First Name", value: "Jane" })];
      const { result, calls } = await runScript(generateFillScript(answers, RESUME, JOB), {
        dom: () => fillable({ "input#first_name": {} }),
      });
      expect(result).toEqual({
        ok: true,
        filled: [{ id: "first_name", label: "First Name", value: "Jane" }],
        skipped: [],
        validation_errors: [],
        frame: null,
      });
      expect(calls).toEqual([
        "wait 1000",
        `waitFor ${ANCHOR}`,
        `elementHandle ${ANCHOR}`,
        "wait 1500",
        "waitFor input#first_name",
        "fill input#first_name",
        "inputValue input#first_name",
      ]);
    });
  });
});
