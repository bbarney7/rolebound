import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { markSeenUrlPromoted } from "../readers/gatherState";

const META = { company: "Acme", title: "Engineering Manager", source: "manual" };

async function readGather(root: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf-8"));
}

describe("markSeenUrlPromoted", () => {
  it("creates a seen_urls entry keyed by URL", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const res = await markSeenUrlPromoted(root, "https://new.example/jobs/1", META);
      expect(res.ok).toBe(true);
      expect(res.warning).toBeNull();
      const state = await readGather(root);
      const entry = state.seen_urls["https://new.example/jobs/1"];
      expect(entry.decision).toBe("promoted");
      expect(entry.company).toBe("Acme");
      expect(entry.title).toBe("Engineering Manager");
      expect(entry.source).toBe("manual");
      expect(Number.isNaN(Date.parse(entry.first_seen))).toBe(false);
      // untouched neighbours
      expect(state.seen_urls["https://omega.com/jobs/3"].decision).toBe("discovered");
      expect(state.last_full_gather).toBe("2026-06-24T21:14:30.367Z");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  /**
   * TEETH: 8 live entries carry decision "discovered-manual", a value that
   * exists in NO source file (job-gatherer.ts:351 declares three). reject_reason
   * is a real optional key. A writer that rebuilt the entry from scratch, or
   * that branched on the old decision, would destroy both. Negative control:
   * replacing the spread with a fresh object literal fails this test.
   */
  it("upserts over an existing entry, preserving first_seen and unknown keys", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const url = "https://weird.example/jobs/9";
      const file = path.join(root, "gather_state.json");
      const before = JSON.parse(await fs.readFile(file, "utf-8"));
      before.seen_urls[url] = {
        first_seen: "2020-01-01T00:00:00.000Z",
        source: "greenhouse",
        company: "WeirdCo",
        title: "Old Title",
        decision: "discovered-manual",
        reject_reason: "too junior",
        some_future_key: 42,
      };
      await fs.writeFile(file, JSON.stringify(before, null, 2));

      const res = await markSeenUrlPromoted(root, url, META);
      expect(res.ok).toBe(true);
      const entry = (await readGather(root)).seen_urls[url];
      expect(entry.decision).toBe("promoted");
      expect(entry.first_seen).toBe("2020-01-01T00:00:00.000Z");
      expect(entry.company).toBe("WeirdCo");
      expect(entry.title).toBe("Old Title");
      expect(entry.source).toBe("greenhouse");
      expect(entry.reject_reason).toBe("too junior");
      expect(entry.some_future_key).toBe(42);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  /**
   * TEETH for D37's null-prototype rebuild. Measured in-session: on an
   * ordinary object `obj["__proto__"] = {…}` creates NO own property and
   * JSON.stringify emits {} for it, so a state file that already carries a
   * `__proto__` key would silently lose it on the read-modify-write — the
   * upsert would report success and durably record nothing.
   *
   * MEASURED CORRECTION to the plan's stated negative control. Replacing the
   * rebuild with a bare in-place map does NOT fail the pre-existing-key half
   * of this test, and neither does a plain `{ ...parsedSeen }`: JSON.parse
   * gives `__proto__` own-property status, and object spread copies it with
   * CreateDataProperty rather than Set, so the setter is never reached. The
   * rebuild earns its keep on the OTHER case — when the upsert KEY is itself
   * `__proto__`, `seen["__proto__"] = entry` on a plain object goes through
   * Object.prototype's setter and creates no own property at all:
   *
   *   plain obj  own __proto__ after assignment: false | stringify: {"a":1}
   *   null-proto own __proto__ after assignment: true  | stringify: {"__proto__":{…}}
   *
   * So this test asserts both halves, and the second is the one with teeth.
   * Negative control (verified to fail): replace `Object.create(null)` + the
   * Object.entries copy with `const seen = (state.seen_urls ?? {}) as …`.
   */
  it("preserves a __proto__ key in seen_urls across the read-modify-write", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const file = path.join(root, "gather_state.json");
      const before = JSON.parse(await fs.readFile(file, "utf-8"));
      // Written through JSON so the key is an OWN property, exactly as it
      // would be in a real file. An object literal here would set the
      // prototype instead and the fixture would be a lie.
      before.seen_urls = JSON.parse(
        JSON.stringify(before.seen_urls).replace(
          /^\{/,
          '{"__proto__":{"first_seen":"2020-01-01T00:00:00.000Z","source":"greenhouse","company":"ProtoCo","title":"Proto Role","decision":"discovered"},',
        ),
      );
      await fs.writeFile(file, JSON.stringify(before, null, 2));

      const res = await markSeenUrlPromoted(root, "https://proto.example/1", META);
      expect(res.ok).toBe(true);

      const raw = await fs.readFile(file, "utf-8");
      // The literal bytes are the assertion that matters: a lost key would
      // simply be absent from the file, and a re-parse could hide that.
      expect(raw).toContain('"__proto__"');

      const after = JSON.parse(raw);
      expect(Object.prototype.hasOwnProperty.call(after.seen_urls, "__proto__")).toBe(true);
      expect(after.seen_urls["__proto__"].company).toBe("ProtoCo");
      expect(after.seen_urls["__proto__"].decision).toBe("discovered");
      // ...and the upsert this call actually made still landed
      expect(after.seen_urls["https://proto.example/1"].decision).toBe("promoted");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  /**
   * TEETH for D37, and the half that the pre-existing-key test above cannot
   * provide. Here the upsert KEY is `__proto__` itself, so the write is
   * `seen["__proto__"] = entry` — which on a plain object invokes
   * Object.prototype's __proto__ setter, creates NO own property, and
   * stringifies to nothing. The call would report ok:true and durably record
   * nothing, which is the silent failure R7 calls "not optional".
   *
   * The route rejects `__proto__` as a URL (D37 part 1), so this is reachable
   * only by calling the writer directly — which is exactly why the writer has
   * to be safe on its own rather than trusting its caller.
   *
   * Negative control (verified to fail with `ok:false` / a missing key):
   * replace `Object.create(null)` + the Object.entries copy with a bare
   * `const seen = (state.seen_urls ?? {}) as …`.
   */
  it("records an upsert whose key is literally __proto__", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const res = await markSeenUrlPromoted(root, "__proto__", META);
      expect(res.ok).toBe(true);

      const raw = await fs.readFile(path.join(root, "gather_state.json"), "utf-8");
      // The bytes are the assertion that matters: a lost key is simply absent.
      expect(raw).toContain('"__proto__"');

      const after = JSON.parse(raw);
      expect(Object.prototype.hasOwnProperty.call(after.seen_urls, "__proto__")).toBe(true);
      expect(after.seen_urls["__proto__"].decision).toBe("promoted");
      expect(after.seen_urls["__proto__"].company).toBe("Acme");
      // the ordinary neighbour is untouched
      expect(after.seen_urls["https://omega.com/jobs/3"].decision).toBe("discovered");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("writes 2-space JSON with no trailing newline and leaves no temp file", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await markSeenUrlPromoted(root, "https://shape.example/1", META);
      const raw = await fs.readFile(path.join(root, "gather_state.json"), "utf-8");
      expect(raw.endsWith("\n")).toBe(false);
      expect(raw).toContain('\n  "seen_urls": {');
      const leftovers = (await fs.readdir(root)).filter(
        (f) => f.endsWith(".tmp") || f.endsWith(".lock"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  /**
   * TEETH for the refusal-to-repair rule: lenientParseFirstDocument would have
   * happily parsed this and re-serialized it, permanently deleting the trailing
   * bytes of a 322 KB agent-owned file as a side effect of queueing one job.
   * The assertion that matters is the BYTE comparison, not the warning.
   */
  it("refuses to rewrite a corrupt gather_state.json and returns a warning", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const file = path.join(root, "gather_state.json");
      const corrupt = `${await fs.readFile(file, "utf-8")}\n}`;
      await fs.writeFile(file, corrupt);
      const res = await markSeenUrlPromoted(root, "https://corrupt.example/1", META);
      expect(res.ok).toBe(false);
      expect(res.warning).toContain("not valid JSON");
      expect(await fs.readFile(file, "utf-8")).toBe(corrupt);
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("warns instead of creating the file when gather_state.json is missing", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const file = path.join(root, "gather_state.json");
      await fs.rm(file, { force: true });
      const res = await markSeenUrlPromoted(root, "https://absent.example/1", META);
      expect(res.ok).toBe(false);
      expect(res.warning).toContain("not found");
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  /**
   * Shaped after lock.test.ts:21-34. Ten concurrent read-modify-writes of the
   * same document must all survive; without withLock this is a lost-update
   * race and later writers clobber earlier ones. The fixture is padded first so
   * each parse/stringify takes long enough for the interleaving to be reliable
   * rather than lucky.
   *
   * Negative control the implementer must run ONCE and record: temporarily
   * replace `withLock(file, fn)` with a bare `await fn()`; this test must fail
   * with fewer than 10 entries.
   */
  it("serializes concurrent upserts without lost writes", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const file = path.join(root, "gather_state.json");
      const padded = JSON.parse(await fs.readFile(file, "utf-8"));
      for (let i = 0; i < 400; i++) {
        padded.seen_urls[`https://pad.example/${i}`] = {
          first_seen: "2026-01-01T00:00:00.000Z",
          source: "greenhouse",
          company: `Pad ${i}`,
          title: "Padding Role",
          decision: "discovered",
        };
      }
      await fs.writeFile(file, JSON.stringify(padded, null, 2));

      const urls = Array.from({ length: 10 }, (_, i) => `https://race.example/jobs/${i}`);
      const results = await Promise.all(urls.map((u) => markSeenUrlPromoted(root, u, META)));
      expect(results.every((r) => r.ok)).toBe(true);

      const state = await readGather(root);
      for (const u of urls) {
        expect(state.seen_urls[u]?.decision).toBe("promoted");
      }
      // the padding survived too — nothing was rebuilt from scratch
      expect(Object.keys(state.seen_urls).length).toBe(1 + 400 + 10);
    } finally {
      await rmFixtureWorkspace(root);
    }
  }, 20_000);
});
