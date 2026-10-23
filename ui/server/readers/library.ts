import { promises as fs } from "node:fs";
import { WorkspaceFileError } from "../../../.pi/extensions/lib/durable-store";
import path from "node:path";
import { createHash } from "node:crypto";
import { paths } from "../workspace";
import { readProfile } from "./profile";
import { readState } from "./stateJson";
import type {
  Address,
  AddressesPayload,
  AddressRow,
  ProfileCityRuleView,
  ResumeFile,
  ResumeReachability,
  ResumeRuleGap,
  ResumesPayload,
} from "../../shared/types";

/**
 * Resume and address joins used after every validated mutation so the response
 * reflects the same resolver semantics the agent uses.
 *
 * The two joins are pure and exported separately from their `fs` shells so they
 * can be tested with no filesystem at all — which is also the only way to
 * exhibit `override` and `shadowed` alongside the other three reachability
 * states in one case (the shared fixture cannot reach them).
 */

// ── Resumes ─────────────────────────────────────────────────────────────────

/**
 * Which resume a file is, read straight off `.pi/extensions/job-applier.ts:79-89`
 * — the only code that ever picks one.
 *
 * THE ORDER OF THESE BRANCHES IS THE RULE, not an implementation detail:
 *
 * 1. A NON-`.pdf` IS ALWAYS AN ORPHAN, AND THIS RUNS FIRST — before the
 *    override branch. `resolveResumePath` only ever builds `resumes/<key>.pdf`
 *    (`job-applier.ts:87`), so a `default.docx` can never be selected WHATEVER
 *    the override says. "Shadowed" means "reachable, but the override wins";
 *    "orphan" means "unreachable, full stop". Calling a `.docx` shadowed would
 *    imply that clearing the override brings it into use, which is false.
 * 2. An override wins for EVERY application. Resolved absolute paths are
 *    compared, not strings, because a RELATIVE override (`resumes/default.pdf`)
 *    resolves back into this very directory (`job-applier.ts:85`) and that file
 *    is then the one file every application actually uses. When the override
 *    resolves outside `resumes/`, every `.pdf` here is shadowed and none is the
 *    override — that is the live workspace's state.
 * 3. Otherwise `default.pdf` or `<rule key>.pdf` is reachable.
 * 4. Everything else is an orphan.
 *
 * Per file rather than per directory because every branch is a property of the
 * one file: `resumesDir` and the already-resolved override are what branch 2
 * needs, and neither depends on the other names present.
 */
export function resumeReachability(
  name: string,
  rules: readonly { key: string }[],
  overrideResolved: string | null,
  resumesDir: string,
): ResumeReachability {
  if (!name.toLowerCase().endsWith(".pdf")) return "orphan";
  if (overrideResolved !== null) {
    return path.resolve(resumesDir, name) === path.resolve(overrideResolved)
      ? "override"
      : "shadowed";
  }
  if (name === "default.pdf") return "default";
  if (rules.some((r) => `${r.key}.pdf` === name)) return "region";
  return "orphan";
}

/**
 * The inverse: a region rule with no `resumes/<key>.pdf` on disk. The agent
 * falls back to `default.pdf` silently (`job-applier.ts:89`), which is worth
 * surfacing.
 */
export function resumeRuleGaps(
  names: readonly string[],
  rules: readonly { key: string }[],
): ResumeRuleGap[] {
  return rules
    .filter((r) => !names.includes(`${r.key}.pdf`))
    .map((r) => ({ key: r.key, expectedFile: `resumes/${r.key}.pdf` }));
}

/** Names and stat only — a PDF is never opened or parsed. ENOENT is data. */
export async function readResumes(root: string): Promise<ResumesPayload> {
  const profile = await readProfile(root);
  const resume = profile.resume;
  const rules = resume?.regionRules ?? [];
  const overrideResolved = resume?.overrideResolved ?? null;
  const dir = paths.resumesDir(root);

  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    return {
      directoryExists: false,
      files: [],
      ruleGaps: resumeRuleGaps([], rules),
      overrideActive: overrideResolved !== null,
      overridePath: resume?.overridePath ?? null,
      overrideExists: resume?.overrideExists ?? null,
    };
  }

  entries.sort((a, b) => a.localeCompare(b));
  const files: ResumeFile[] = [];
  for (const name of entries) {
    const stat = await fs.stat(path.join(dir, name));
    files.push({
      name,
      key: name.replace(/\.[^.]+$/, ""),
      bytes: stat.size,
      modifiedAt: Number.isNaN(stat.mtimeMs) ? null : new Date(stat.mtimeMs).toISOString(),
      reachability: resumeReachability(name, rules, overrideResolved, dir),
    });
  }

  return {
    directoryExists: true,
    files,
    ruleGaps: resumeRuleGaps(entries, rules),
    overrideActive: overrideResolved !== null,
    overridePath: resume?.overridePath ?? null,
    overrideExists: resume?.overrideExists ?? null,
  };
}

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * Left-join the city rules against the persisted addresses on `key`/`cityKey`.
 *
 * `default` IS NEVER AN ORPHAN. `parseCityRules:271` skips the `default` row
 * explicitly (`` `default` = remote, handled in code ``) and `matchResume`
 * returns `address_city_key: "default"` for every remote posting, so a
 * `default` key in `state.json.addresses` is correct and expected. A naive
 * left-join flags it; this one must not.
 */
export function addressRows(
  cityRules: readonly ProfileCityRuleView[],
  addresses: readonly Address[],
): AddressRow[] {
  const rows: AddressRow[] = cityRules.map((rule) => {
    const address = addresses.find((a) => a.cityKey === rule.key) ?? null;
    return {
      key: rule.key,
      displayCity: rule.city,
      state: rule.state,
      zips: rule.zips,
      address,
      ruleState: address ? "resolved" : "pending",
    };
  });

  for (const address of addresses) {
    if (cityRules.some((r) => r.key === address.cityKey)) continue;
    rows.push({
      key: address.cityKey,
      displayCity: address.city,
      state: address.state,
      zips: address.zip ? [address.zip] : [],
      address,
      ruleState: address.cityKey === "default" ? "resolved" : "orphan",
    });
  }

  return rows;
}

/**
 * Never throws, because `GET /api/addresses` sits in a sentinel loop that
 * demands 200.
 *
 * Corrupt `state.json` (`WorkspaceFileError` CORRUPT from `readState`) becomes
 * `stateJsonReadable: false` with an empty row list. Any other error rethrows.
 */
export async function readAddresses(root: string): Promise<AddressesPayload> {
  const profile = await readProfile(root);
  const cityRules = profile.cityRules;

  try {
    const state = await readState(root);
    return {
      revision: createHash("sha256").update(await fs.readFile(paths.stateJson(root))).digest("hex"),
      rows: addressRows(cityRules, state.addresses),
      stateJsonExists: true,
      stateJsonReadable: true,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { revision: null, rows: addressRows(cityRules, []), stateJsonExists: false, stateJsonReadable: true };
    }
    if (
      err instanceof SyntaxError ||
      err instanceof TypeError ||
      (err instanceof WorkspaceFileError && err.code === "CORRUPT")
    ) {
      return { revision: null, rows: addressRows(cityRules, []), stateJsonExists: true, stateJsonReadable: false };
    }
    throw err;
  }
}
