import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFTS,
  addressStateLabel,
  addressStateTone,
  bodyKey,
  bulletKey,
  bulletFieldDisplayValue,
  bulletPlaceholderHint,
  changedBullets,
  commitDraft,
  draftsFromPayload,
  isBulletTemplatePlaceholder,
  reachabilityLabel,
  reachabilityTone,
  resumeFileUsageSentence,
  reconcileDrafts,
  sectionFallback,
  sectionIsDirty,
  sectionLabel,
  sectionOfKey,
} from "../profile";
import {
  ADDRESS_RULE_STATES,
  PROFILE_SECTION_IDS,
  RESUME_REACHABILITY,
  type ProfileBullet,
  type ProfilePayload,
} from "../../shared/types";

/**
 * Node environment, no rendering: this directory has no jsdom and no
 * testing-library, so only pure helpers are covered here — those of
 * `src/profile.ts`. The fetch wrappers are covered end-to-end by the server
 * suite (`server/__tests__/profile.test.ts`), and the components that consume
 * these helpers are exercised by hand under `npm run dev:fixture`.
 *
 * The four `reconcileDrafts` cases are the ones that matter. `profile.md` sits
 * at depth 0 and matches none of the six `WATCH_IGNORED` patterns, so EVERY
 * section save fires an SSE frame and a full `refresh()`; without the dirty
 * rule asserted here, an unsaved draft in a sibling sub-tab silently reverts.
 * There is no rendering test in this package that could catch that.
 */

function bullet(key: string, value: string | null): ProfileBullet {
  return { key, label: key.charAt(0).toUpperCase() + key.slice(1), value };
}

/**
 * Only the three fields `draftsFromPayload` reads carry defaults worth setting;
 * everything else is the empty shape a workspace with no `profile.md` produces.
 */
function payload(overrides: Partial<ProfilePayload> = {}): ProfilePayload {
  return {
    revision: "fixture-revision",
    exists: true,
    templateAvailable: true,
    warnings: [],
    sections: PROFILE_SECTION_IDS.map((id) => ({ id, heading: null, present: false, line: null })),
    identity: null,
    preferences: null,
    qaBank: null,
    workHistory: [],
    markdownBodies: {},
    resume: null,
    cityRules: [],
    cityRuleTableRows: 0,
    ...overrides,
  };
}

function identityPayload(
  bullets: ProfileBullet[],
  extra: Partial<ProfilePayload> = {},
): ProfilePayload {
  return payload({
    identity: {
      bullets,
      parsed: {
        fullName: null,
        firstName: null,
        lastName: null,
        email: null,
        fallbackEmail: null,
        phone: null,
      },
    },
    ...extra,
  });
}

const EMAIL = bulletKey("identity", "email");
const PHONE = bulletKey("identity", "phone");
const QA = bodyKey("qaBank");

describe("key constructors", () => {
  it("keeps the two shapes distinguishable and reversible", () => {
    expect(bodyKey("qaBank")).toBe("qaBank");
    expect(bulletKey("identity", "email")).toBe("identity.email");
    expect(sectionOfKey(QA)).toBe("qaBank");
    expect(sectionOfKey(EMAIL)).toBe("identity");
  });
});

describe("draftsFromPayload", () => {
  it("flattens identity bullets, preference bullets and the Q&A body onto one map", () => {
    const profile = identityPayload([bullet("email", "me@example.com"), bullet("github", null)], {
      preferences: {
        bullets: [bullet("topics", "backend, platform")],
        topics: ["backend", "platform"],
        titleBlocklist: null,
      },
      qaBank: "- **Salary:** ask\n",
    });

    expect(draftsFromPayload(profile)).toEqual({
      "identity.email": "me@example.com",
      // A bullet whose value the parser discards is still an editable string.
      "identity.github": "",
      "searchPreferences.topics": "backend, platform",
      qaBank: "- **Salary:** ask\n",
    });
  });

  it("omits an absent section entirely — absent is not the same as empty", () => {
    expect(draftsFromPayload(payload())).toEqual({});
    expect(draftsFromPayload(identityPayload([]))).toEqual({});
    // Present but empty: the Q&A section exists on disk with an empty body.
    expect(draftsFromPayload(payload({ qaBank: "" }))).toEqual({ qaBank: "" });
  });
});

describe("reconcileDrafts", () => {
  // 13.1
  it("seeds every draft and baseline from the first payload", () => {
    const next = reconcileDrafts(EMPTY_DRAFTS, {
      [EMAIL]: "me@example.com",
      [QA]: "- **Salary:** ask\n",
    });

    expect(next.drafts).toEqual({ [EMAIL]: "me@example.com", [QA]: "- **Salary:** ask\n" });
    expect(next.baselines).toEqual(next.drafts);
    expect(next.conflicts).toEqual([]);
  });

  // 13.2
  it("re-seeds a clean draft from a new payload", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [EMAIL]: "old@example.com" });
    const next = reconcileDrafts(seeded, { [EMAIL]: "new@example.com" });

    expect(next.drafts[EMAIL]).toBe("new@example.com");
    expect(next.baselines[EMAIL]).toBe("new@example.com");
    expect(next.conflicts).toEqual([]);
  });

  // 13.3 — THE SAVE-A-SIBLING CASE, and the reason this module exists.
  it("keeps a dirty draft when the payload matches its baseline", () => {
    // Q&A is being edited; the user saves Identity in another sub-tab, which
    // writes profile.md, which fires an SSE frame, which refreshes everything.
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [EMAIL]: "me@example.com", [QA]: "on disk" });
    const dirty = { ...seeded, drafts: { ...seeded.drafts, [QA]: "half-typed answer" } };

    const next = reconcileDrafts(dirty, { [EMAIL]: "changed@example.com", [QA]: "on disk" });

    expect(next.drafts[QA]).toBe("half-typed answer");
    expect(next.baselines[QA]).toBe("on disk");
    expect(next.conflicts).toEqual([]);
    // The clean sibling took the server's value, which is the other half.
    expect(next.drafts[EMAIL]).toBe("changed@example.com");
  });

  // 13.4
  it("keeps a dirty draft AND raises a conflict when the payload differs from its baseline", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [QA]: "on disk" });
    const dirty = { ...seeded, drafts: { ...seeded.drafts, [QA]: "half-typed answer" } };

    // Someone edited profile.md in an editor while the draft was dirty.
    const next = reconcileDrafts(dirty, { [QA]: "edited elsewhere" });

    expect(next.drafts[QA]).toBe("half-typed answer");
    // The OLD baseline is kept: adopting the new one would make the draft look
    // dirty against a value the user has never seen, and the conflict would
    // silently resolve itself on the next frame.
    expect(next.baselines[QA]).toBe("on disk");
    expect(next.conflicts).toEqual([QA]);
  });

  // 13.5
  it("clears a conflict once the draft is committed", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [QA]: "on disk" });
    const dirty = { ...seeded, drafts: { ...seeded.drafts, [QA]: "mine" } };
    const conflicted = reconcileDrafts(dirty, { [QA]: "theirs" });
    expect(conflicted.conflicts).toEqual([QA]);

    const committed = commitDraft(conflicted, QA, "theirs");
    expect(committed.conflicts).toEqual([]);
    expect(committed.drafts[QA]).toBe("theirs");
    expect(committed.baselines[QA]).toBe("theirs");
    // And the next frame does not resurrect it.
    expect(reconcileDrafts(committed, { [QA]: "theirs" }).conflicts).toEqual([]);
  });

  // 13.6
  it("drops a key that disappears from the payload out of all three maps", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [EMAIL]: "me@example.com", [QA]: "on disk" });
    const dirty = { ...seeded, drafts: { ...seeded.drafts, [QA]: "mine" } };
    const conflicted = reconcileDrafts(dirty, { [QA]: "theirs" });
    expect(conflicted.conflicts).toEqual([QA]);

    // The Q&A section was deleted from profile.md.
    const next = reconcileDrafts(conflicted, { [EMAIL]: "me@example.com" });

    expect(Object.keys(next.drafts)).toEqual([EMAIL]);
    expect(Object.keys(next.baselines)).toEqual([EMAIL]);
    expect(next.conflicts).toEqual([]);
  });

  it("survives a payload with nothing in it at all", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, { [EMAIL]: "me@example.com" });
    expect(reconcileDrafts(seeded, {})).toEqual(EMPTY_DRAFTS);
  });
});

describe("commitDraft", () => {
  // 13.7
  it("clears dirty for one key and leaves every other key alone", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, {
      [EMAIL]: "old@example.com",
      [PHONE]: "555-0100",
      [QA]: "on disk",
    });
    const dirty = {
      ...seeded,
      drafts: { ...seeded.drafts, [EMAIL]: "new@example.com", [QA]: "mine" },
    };
    expect(sectionIsDirty(dirty, "identity")).toBe(true);
    expect(sectionIsDirty(dirty, "qaBank")).toBe(true);

    const committed = commitDraft(dirty, EMAIL, "new@example.com");

    expect(sectionIsDirty(committed, "identity")).toBe(false);
    expect(committed.baselines[EMAIL]).toBe("new@example.com");
    // The untouched sibling in the same section, and the dirty one in another.
    expect(committed.drafts[PHONE]).toBe("555-0100");
    expect(committed.drafts[QA]).toBe("mine");
    expect(sectionIsDirty(committed, "qaBank")).toBe(true);
  });
});

describe("changedBullets", () => {
  const bullets = [bullet("email", "me@example.com"), bullet("phone", "555-0100"), bullet("github", null)];

  // 13.8
  it("sends nothing for a form nobody touched", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(bullets)));
    expect(changedBullets("identity", bullets, seeded.drafts)).toEqual({});
  });

  // 13.9
  it("sends only the keys that were actually edited", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(bullets)));
    const drafts = { ...seeded.drafts, [PHONE]: "555-0199" };
    expect(changedBullets("identity", bullets, drafts)).toEqual({ phone: "555-0199" });
  });

  it("ignores a draft key belonging to another section", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(bullets)));
    const drafts = { ...seeded.drafts, [bulletKey("searchPreferences", "email")]: "other" };
    expect(changedBullets("identity", bullets, drafts)).toEqual({});
  });

  // 13.10
  it("maps an emptied value to null, not to an empty string (Q6)", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(bullets)));
    const drafts = { ...seeded.drafts, [EMAIL]: "" };
    const changed = changedBullets("identity", bullets, drafts);
    expect(changed).toEqual({ email: null });
    // Explicitly null rather than absent: the route uses hasOwnProperty, so
    // absent would mean "leave it" and the clear would be silently dropped.
    expect(Object.prototype.hasOwnProperty.call(changed, "email")).toBe(true);
  });

  it("does not resend a bullet whose parsed value is null and whose input is still blank", () => {
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(bullets)));
    expect(changedBullets("identity", bullets, seeded.drafts)).not.toHaveProperty("github");
  });

  // 13.11
  it("counts a whitespace-only change as a real edit (Q4)", () => {
    // The writer stores raw text and `cleanValue` trims on the READ side, so
    // trimming here would silently discard an edit the user made and break the
    // byte-level round-trip claim.
    const stored = [bullet("email", "me@example.com")];
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(stored)));
    const drafts = { ...seeded.drafts, [EMAIL]: "  me@example.com  " };
    expect(changedBullets("identity", stored, drafts)).toEqual({ email: "  me@example.com  " });
  });

  it("treats editing away stored padding as an edit too", () => {
    const stored = [bullet("email", " me@example.com ")];
    const seeded = reconcileDrafts(EMPTY_DRAFTS, draftsFromPayload(identityPayload(stored)));
    const drafts = { ...seeded.drafts, [EMAIL]: "me@example.com" };
    expect(changedBullets("identity", stored, drafts)).toEqual({ email: "me@example.com" });
  });
});

describe("bullet template placeholders", () => {
  const italic =
    "*(optional — used only when an ATS signup form rejects `+aliasing`)*";

  it("detects catalog and italic placeholders", () => {
    expect(isBulletTemplatePlaceholder("<FILL IN>")).toBe(true);
    expect(isBulletTemplatePlaceholder(italic)).toBe(true);
    expect(isBulletTemplatePlaceholder("real@example.com")).toBe(false);
  });

  it("maps placeholders to display hints", () => {
    expect(bulletPlaceholderHint("<FILL IN>")).toBe("Required");
    expect(bulletPlaceholderHint(italic)).toBe(
      "optional — used only when an ATS signup form rejects +aliasing",
    );
    expect(bulletFieldDisplayValue(italic)).toBe("");
  });

  it("skips untouched placeholders in changedBullets", () => {
    const bullets = [bullet("fallback", italic)];
    const drafts = { [bulletKey("identity", "fallback")]: italic };
    expect(changedBullets("identity", bullets, drafts)).toEqual({});
  });
});

describe("resumeFileUsageSentence", () => {
  it("describes region and non-pdf files in plain language", () => {
    expect(
      resumeFileUsageSentence(
        { name: "notes.docx", key: "notes", reachability: "orphan" },
        [],
      ),
    ).toBe("Only PDFs can be sent with applications");
    expect(
      resumeFileUsageSentence(
        { name: "denver.pdf", key: "denver", reachability: "region" },
        [{ key: "denver", terms: ["Denver", "Boulder"] }],
      ),
    ).toBe("Used for jobs in Denver or Boulder");
  });
});

describe("reachabilityTone / reachabilityLabel", () => {
  // 13.12
  it("gives every reachability state a tone and keeps its word", () => {
    expect(RESUME_REACHABILITY.map(reachabilityTone)).toEqual([
      "good", // default
      "good", // region
      "warn", // orphan
      "neutral", // shadowed
      "good", // override
    ]);
    for (const state of RESUME_REACHABILITY) {
      expect(reachabilityLabel(state)).toBe(state);
    }
  });

  it("falls back to neutral for a word this client does not know", () => {
    // Widened to `string` on purpose, exactly as `loginStatusTone` is: a server
    // of a different vintage must not crash the whole table.
    expect(reachabilityTone("archived")).toBe("neutral");
    expect(reachabilityLabel("archived")).toBe("archived");
  });
});

describe("addressStateTone / addressStateLabel", () => {
  // 13.13
  it("gives every address state a tone and keeps its word", () => {
    expect(ADDRESS_RULE_STATES.map(addressStateTone)).toEqual([
      "good", // resolved
      "neutral", // pending
      "warn", // orphan
    ]);
    for (const state of ADDRESS_RULE_STATES) {
      expect(addressStateLabel(state)).toBe(state);
    }
  });

  it("falls back to neutral for a word this client does not know", () => {
    expect(addressStateTone("stale")).toBe("neutral");
    expect(addressStateLabel("stale")).toBe("stale");
  });
});

describe("sectionLabel / sectionFallback", () => {
  // 13.14 — exhaustive at compile time via the Record, asserted here at runtime
  // so adding a ProfileSectionId without a label fails in this file too.
  it("labels every ProfileSectionId with something a user can read", () => {
    for (const id of PROFILE_SECTION_IDS) {
      const label = sectionLabel(id);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      // A label is prose, not the id echoed back.
      expect(label).not.toBe(id);
    }
    expect(new Set(PROFILE_SECTION_IDS.map(sectionLabel)).size).toBe(PROFILE_SECTION_IDS.length);
  });

  it("says what the agent falls back to for every section (AC 3)", () => {
    for (const id of PROFILE_SECTION_IDS) {
      // "This section is missing" is never the whole message — the empty state
      // has to say whether the absence costs the user anything.
      expect(sectionFallback(id).length).toBeGreaterThan(20);
    }
    expect(new Set(PROFILE_SECTION_IDS.map(sectionFallback)).size).toBe(
      PROFILE_SECTION_IDS.length,
    );
  });
});
